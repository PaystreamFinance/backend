import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import type {
  ArbTradeRequest,
  ArbTradeSuccessResponse,
  ArbTradeErrorResponse,
  ArbTradeLegResult,
  ArbProtocol,
} from '../../models/arb'
import { getInitializedProviders, getCachedMarketData } from '@paystream/perps/registry'
import { HyperliquidArbProvider, normalizeHyperliquidSymbol } from '@paystream/perps/providers/hyperliquid-provider'
import { Hip3HyperliquidArbProvider } from '@paystream/perps/providers/hip3-hyperliquid-provider'
import { parseHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import {
  PacificaArbProvider,
  createPacificaPayload,
  createReferralClaimPayload,
  claimPacificaReferralCode,
  executePacificaMarketOrder,
  normalizePacificaSymbol,
  setPacificaLeverage,
  setPacificaMarginMode,
} from '@paystream/perps/providers/pacifica-provider'
import { AsterArbProvider, normalizeAsterSymbol } from '@paystream/perps/providers/aster-provider'
import { LighterArbProvider, normalizeLighterSymbol } from '@paystream/perps/providers/lighter-provider'
import { ZoArbProvider } from '@paystream/perps/providers/zo-provider'
import { PhoenixArbProvider, normalizePhoenixSymbol } from '@paystream/perps/providers/phoenix-provider'
import { closePacificaPosition, closePhoenixPosition } from './close'
import { getOrCreateAsterApiCredentials } from '../../clients/arb/aster-auth'
import { getOrCreateLighterApiCredentials } from '../../clients/arb/lighter-auth'
import { getOrCreateZoSession, runWithZoSessionInvalidation } from '../../clients/arb/zo-auth'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../utils/wallet'
import { connection } from '../../clients/solana'
import { serializeTransactionForPrivy } from '../../utils/transaction'
import { SOLANA_CAIP2 } from '../../utils/constants'
import { privy, getAuthorizationContext, signMessageWithPrivy, createHyperliquidViemAccount, getWalletById } from '../../clients/privy'
import { log } from '../../utils/log'
import { db } from '@paystream/db'
import { arbPositionPairs } from '@paystream/db/schema'

/** Max oracle-price divergence between two legs of a cross-ticker pair. */

/**
 * POST /api/arb/trade
 * Execute arbitrage by opening hedged positions on two protocols using a
 * single normalized ticker (same ticker on both dexes).
 */
export async function tradeHandler(c: Context) {
  const authData = c.privyUser
  if (!authData) {
    const response: ArbTradeErrorResponse = {
      status: 'error',
      message: 'User not authenticated',
      error: 'Authentication required',
    }
    return c.json(response, 401)
  }

  const body = await c.req.json().catch(() => ({})) as ArbTradeRequest
  const { market, totalMarginUsd, leverage, protocols } = body
  const disableAclp = body.disableAclp === true
  const disableAutoclose = body.disableAutoclose === true

  if (!market) {
    const response: ArbTradeErrorResponse = {
      status: 'error',
      message: 'Market symbol is required',
      error: 'Missing required field: market',
    }
    return c.json(response, 400)
  }

  return executeArbTradeFlow(c, {
    longMarket: market,
    shortMarket: market,
    longProtocol: protocols?.long as ArbProtocol,
    shortProtocol: protocols?.short as ArbProtocol,
    totalMarginUsd,
    leverage,
    disableAclp,
    disableAutoclose,
    logTag: market,
  })
}

/**
 * Shared entry point for v1 (single-ticker) and v2 (per-leg-ticker) arb trade
 * flows. Handles auth, validation, wallet extraction, provider init, target
 * size compute, and delegates execution + persistence to handleRestApiTrade.
 */
export async function executeArbTradeFlow(
  c: Context,
  input: {
    longMarket: string
    shortMarket: string
    longProtocol: ArbProtocol
    shortProtocol: ArbProtocol
    totalMarginUsd: number
    leverage: number
    disableAclp: boolean
    disableAutoclose: boolean
    /** Display label for logs (e.g. single market or "XAU/GOLD") */
    logTag: string
  },
) {
  let registry = null

  try {
    const authData = c.privyUser!
    const { longMarket, shortMarket, longProtocol, shortProtocol, totalMarginUsd, leverage, disableAclp, disableAutoclose, logTag } = input

    const embeddedWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedWallet) {
      const response: ArbTradeErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
      }
      return c.json(response, 400)
    }

    log.info(`[arb/trade] ${logTag} totalMargin=$${totalMarginUsd} leverage=${leverage}x long=${longProtocol}:${longMarket} short=${shortProtocol}:${shortMarket}${disableAclp ? ' [ACLP DISABLED]' : ''}${disableAutoclose ? ' [AUTOCLOSE DISABLED]' : ''}`)

    if (!totalMarginUsd || totalMarginUsd <= 0) {
      const response: ArbTradeErrorResponse = {
        status: 'error',
        message: 'Total margin must be a positive number',
        error: 'Invalid totalMarginUsd',
      }
      return c.json(response, 400)
    }

    if (!leverage || leverage < 1) {
      const response: ArbTradeErrorResponse = {
        status: 'error',
        message: 'Leverage must be at least 1',
        error: 'Invalid leverage',
      }
      return c.json(response, 400)
    }

    if (!longProtocol || !shortProtocol) {
      const response: ArbTradeErrorResponse = {
        status: 'error',
        message: 'Must specify protocol for both long and short positions',
        error: 'Invalid protocols configuration',
      }
      return c.json(response, 400)
    }

    if (longProtocol === shortProtocol) {
      const response: ArbTradeErrorResponse = {
        status: 'error',
        message: 'Long and short must use different protocols for arbitrage',
        error: 'Invalid protocols: same protocol for both directions',
      }
      return c.json(response, 400)
    }

    if (!longMarket || !shortMarket) {
      const response: ArbTradeErrorResponse = {
        status: 'error',
        message: 'Ticker is required for both long and short legs',
        error: 'Missing required field: ticker',
      }
      return c.json(response, 400)
    }

    // Extract Ethereum wallet for Hyperliquid/Aster (if needed)
    let embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    const walletPubkey = new PublicKey(embeddedWallet.address)
    const neededProtocols = [...new Set([longProtocol, shortProtocol])]

    // Kick off ETH wallet verification, provider init, and market data cache in parallel
    const [verifiedEthWallet, initializedRegistry] = await Promise.all([
      embeddedEthWallet
        ? getWalletById(embeddedEthWallet.walletId).then(verified => {
            if (verified && verified.address !== embeddedEthWallet!.address) {
              log.warn(`[arb/trade] ETH wallet address mismatch, using verified: ${verified.address}`)
              return { ...embeddedEthWallet!, address: verified.address }
            }
            return embeddedEthWallet!
          }).catch(() => embeddedEthWallet!)
        : Promise.resolve(null),
      getInitializedProviders(walletPubkey, embeddedEthWallet?.address, neededProtocols),
      getCachedMarketData().catch(() => null), // pre-warm cache
    ])
    embeddedEthWallet = verifiedEthWallet
    registry = initializedRegistry

    const longProvider = registry.getProvider(longProtocol)
    const shortProvider = registry.getProvider(shortProtocol)

    if (!longProvider) {
      const response: ArbTradeErrorResponse = {
        status: 'error',
        message: `Provider "${longProtocol}" not available`,
        error: 'Provider not found',
      }
      await registry.cleanup()
      return c.json(response, 400)
    }

    if (!shortProvider) {
      const response: ArbTradeErrorResponse = {
        status: 'error',
        message: `Provider "${shortProtocol}" not available`,
        error: 'Provider not found',
      }
      await registry.cleanup()
      return c.json(response, 400)
    }

    // Split margin equally between positions
    const marginPerSide = totalMarginUsd / 2
    const notionalUsd = marginPerSide * leverage

    log.info(`[arb/trade] Per side: $${marginPerSide} margin, $${notionalUsd} notional — long=${longProtocol} short=${shortProtocol}`)

    const authContext = getAuthorizationContext()


    // Compute a single target size for both legs to ensure delta-neutral matching.
    // Use the coarsest lot size among the two protocols, round UP to meet minimums.
    const targetSizeAsset = await computeTargetSize(longMarket, shortMarket, notionalUsd, longProtocol, shortProtocol, registry)
    if (targetSizeAsset) {
      log.info(`[arb/trade] Target size: ${targetSizeAsset} (long=${longMarket}, short=${shortMarket})`)
    }

    return await handleRestApiTrade(
      c,
      embeddedWallet,
      embeddedEthWallet,
      walletPubkey,
      longMarket,
      shortMarket,
      marginPerSide,
      leverage,
      longProtocol,
      shortProtocol,
      longProvider,
      shortProvider,
      authContext,
      registry,
      targetSizeAsset,
      authData.user.id,
      disableAclp,
      disableAutoclose,
    )
  } catch (error) {
    log.error('[arb/trade] Error:', error instanceof Error ? error.message : error)

    if (registry) {
      try {
        await registry.cleanup()
      } catch (cleanupError) {
        log.error('[arb/trade] Error cleaning up:', cleanupError)
      }
    }

    const rawMsg = error instanceof Error ? error.message : 'Unknown error'
    const errorResponse: ArbTradeErrorResponse = {
      status: 'error',
      message: sanitizeArbError(rawMsg, 'trade'),
    }
    return c.json(errorResponse, 500)
  }
}

/**
 * Handle trades involving REST API protocols (Pacifica, Hyperliquid, Aster, or Lighter)
 * Cannot be bundled atomically, execute separately
 */
// Minimum order value for REST API protocols
const MIN_ORDER_VALUE_USD = 10

async function handleRestApiTrade(
  c: Context,
  embeddedWallet: { walletId: string; address: string },
  embeddedEthWallet: { walletId: string; address: string } | null,
  walletPubkey: PublicKey,
  longMarket: string,
  shortMarket: string,
  marginPerSide: number,
  leverage: number,
  longProtocol: ArbProtocol,
  shortProtocol: ArbProtocol,
  longProvider: any,
  shortProvider: any,
  authContext: { authorization_private_keys: string[] },
  registry: any,
  targetSizeAsset?: number,
  privyUserId?: string,
  disableAclp: boolean = false,
  disableAutoclose: boolean = false,
) {
  try {
    const notionalUsd = marginPerSide * leverage

    // Resolve per-leg market by protocol. Long/short cannot share a protocol
    // (validated upstream) so this mapping is always unambiguous.
    const marketFor = (protocol: ArbProtocol): string =>
      protocol === longProtocol ? longMarket : shortMarket

    // Resolve Pacifica lot size if needed (per-market from tick_size)
    const hasPacificaLeg = longProtocol === 'pacifica' || shortProtocol === 'pacifica'
    let pacificaLotSize = 0.01
    if (hasPacificaLeg) {
      const pacificaProvider = registry.getPacificaProvider() as PacificaArbProvider | null
      if (pacificaProvider) {
        const pacificaMarket = marketFor('pacifica')
        pacificaLotSize = pacificaProvider.getLotSize(pacificaMarket)
        log.info(`[arb/trade] Pacifica lot size for ${pacificaMarket}: ${pacificaLotSize}`)
      }
    }

    // Resolve Aster lot size if needed
    const hasAsterLeg = longProtocol === 'aster' || shortProtocol === 'aster'
    let asterLotSize = 0.01
    if (hasAsterLeg) {
      const asterProvider = registry.getAsterProvider() as AsterArbProvider | null
      if (asterProvider) {
        const asterMarket = marketFor('aster')
        asterLotSize = asterProvider.getLotSize(asterMarket)
        log.info(`[arb/trade] Aster lot size for ${asterMarket}: ${asterLotSize}`)
      }
    }

    // Resolve Lighter lot size if needed
    const hasLighterLeg = longProtocol === 'lighter' || shortProtocol === 'lighter'
    let lighterLotSize = 0.01
    if (hasLighterLeg) {
      const lighterProvider = registry.getLighterProvider() as LighterArbProvider | null
      if (lighterProvider) {
        const lighterMarket = marketFor('lighter')
        lighterLotSize = lighterProvider.getLotSize(lighterMarket)
        log.info(`[arb/trade] Lighter lot size for ${lighterMarket}: ${lighterLotSize}`)
      }
    }

    // Resolve Phoenix lot size if needed
    const hasPhoenixLeg = longProtocol === 'phoenix' || shortProtocol === 'phoenix'
    let phoenixLotSize = 0.000001
    if (hasPhoenixLeg) {
      const phoenixProvider = registry.getPhoenixProvider() as PhoenixArbProvider | null
      if (phoenixProvider) {
        const phoenixMarket = marketFor('phoenix')
        phoenixLotSize = phoenixProvider.getLotSize(phoenixMarket)
        const maxLev = phoenixProvider.getMaxLeverage(phoenixMarket)
        log.info(`[arb/trade] Phoenix lot size for ${phoenixMarket}: ${phoenixLotSize}, maxLev=${maxLev}x`)
      }
    }

    if (notionalUsd < MIN_ORDER_VALUE_USD) {
      await registry.cleanup()
      const tooSmallProtocol = longProtocol
      const response: ArbTradeErrorResponse = {
        status: 'error',
        message: `Minimum order value for ${tooSmallProtocol} is $${MIN_ORDER_VALUE_USD}. Your position would be $${notionalUsd.toFixed(2)}.`,
        error: 'Order value too small',
      }
      return c.json(response, 400)
    }

    // Pre-flight balance checks — reject BEFORE opening any legs
    const preflightErrors: string[] = []

    // Check Lighter balance
    if (longProtocol === 'lighter' || shortProtocol === 'lighter') {
      const lighterProvider = registry.getLighterProvider() as LighterArbProvider | null
      if (lighterProvider && embeddedEthWallet) {
        try {
          // Initialize credentials so we can check balance
          const creds = await getOrCreateLighterApiCredentials(
            privyUserId || '', embeddedEthWallet.address, embeddedEthWallet.walletId, authContext
          )
          await lighterProvider.setCredentials(creds)
          lighterProvider.setEthAddress(embeddedEthWallet.address)

          const balance = await lighterProvider.getAccountBalance()
          if (balance !== null && marginPerSide > balance * 0.98) {
            preflightErrors.push(
              `Insufficient Lighter balance: $${balance.toFixed(2)} available, $${marginPerSide.toFixed(2)} margin required`
            )
          }
        } catch (e) {
          log.warn('[arb/trade] Lighter preflight balance check failed:', e)
        }
      }
    }

    // 01 has no set-leverage action; leverage is controlled by sizing the
    // order relative to the engine's "Max Available to Trade":
    //   max_notional = (omf − imf) / IMF_base_market
    // Abort if our per-side notional exceeds that, since the engine would
    // either reject the order or open it at max leverage for the market.
    if (longProtocol === '01' || shortProtocol === '01') {
      const zoProvider = registry.getZoProvider() as ZoArbProvider | null
      if (zoProvider) {
        const zoMarket = marketFor('01')
        const maxLev = zoProvider.getMaxLeverage(zoMarket)
        if (leverage > maxLev) {
          preflightErrors.push(
            `01 max leverage for ${zoMarket} is ${maxLev}x; requested ${leverage}x`
          )
        }

        try {
          const maxNotional = await zoProvider.getMaxNotional(walletPubkey, zoMarket)
          if (maxNotional !== null && notionalUsd > maxNotional * 0.98) {
            preflightErrors.push(
              `Insufficient 01 equity: max notional $${maxNotional.toFixed(2)} available, $${notionalUsd.toFixed(2)} required`
            )
          }
        } catch (e) {
          log.warn('[arb/trade] 01 preflight max-notional check failed:', e)
        }
      }
    }

    // Aster caps (1) max leverage per symbol via bracket tiers and (2) total
    // symbol position notional (existing + new) via `maxNotionalValue` returned
    // from `POST /fapi/v1/leverage`. Both checks run here so we reject before
    // opening any leg. The leverage POST is idempotent — running it now is
    // equivalent to running it inside executeTrade.
    if (longProtocol === 'aster' || shortProtocol === 'aster') {
      const asterProvider = registry.getAsterProvider() as AsterArbProvider | null
      if (asterProvider && embeddedWallet && privyUserId) {
        try {
          const creds = await getOrCreateAsterApiCredentials(
            privyUserId, embeddedWallet.address, embeddedWallet.walletId, authContext
          )
          asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)

          const asterMarket = marketFor('aster')
          const levCap = asterProvider.getMaxLeverageForNotional(asterMarket, notionalUsd)
            ?? asterProvider.getMaxLeverage(asterMarket)
          if (levCap != null && leverage > levCap) {
            preflightErrors.push(
              `Aster max leverage for ${asterMarket} at $${notionalUsd.toFixed(2)} notional is ${levCap}x; requested ${leverage}x`
            )
          }

          const check = await asterProvider.getEffectiveMaxNotional(asterMarket, leverage)
          if (check !== null) {
            const { maxNotional, existingNotional, headroom } = check
            if (notionalUsd > headroom * 0.98) {
              preflightErrors.push(
                existingNotional > 0
                  ? `Aster ${asterMarket} has $${existingNotional.toFixed(2)} open; only $${headroom.toFixed(2)} of $${maxNotional.toFixed(2)} cap remaining, $${notionalUsd.toFixed(2)} requested`
                  : `Aster ${asterMarket} max notional at ${leverage}x is $${maxNotional.toFixed(2)}, $${notionalUsd.toFixed(2)} requested`
              )
            }
          }
        } catch (e) {
          log.warn('[arb/trade] Aster preflight leverage/notional check failed:', e)
        }
      }
    }

    if (longProtocol === 'phoenix' || shortProtocol === 'phoenix') {
      const phoenixProvider = registry.getPhoenixProvider() as PhoenixArbProvider | null
      if (phoenixProvider) {
        const phoenixMarket = marketFor('phoenix')
        const maxLev = phoenixProvider.getMaxLeverage(phoenixMarket)
        if (maxLev > 0 && leverage > maxLev) {
          preflightErrors.push(
            `Phoenix max leverage for ${phoenixMarket} is ${maxLev}x; requested ${leverage}x`
          )
        }

        if (embeddedWallet) {
          try {
            const balance = await phoenixProvider.getBalance(embeddedWallet.address)
            const phoenixLegCount =
              Number(longProtocol === 'phoenix') + Number(shortProtocol === 'phoenix')
            const requiredFreeUsdc = marginPerSide * phoenixLegCount
            if (balance.freeUsdc > 0 && requiredFreeUsdc > balance.freeUsdc * 0.98) {
              preflightErrors.push(
                `Insufficient Phoenix balance: $${balance.freeUsdc.toFixed(2)} available, $${requiredFreeUsdc.toFixed(2)} margin required`
              )
            } else if (balance.freeUsdc <= 0 && requiredFreeUsdc > 0) {
              preflightErrors.push(
                `Insufficient Phoenix balance: $${balance.freeUsdc.toFixed(2)} available, $${requiredFreeUsdc.toFixed(2)} margin required`
              )
            }
          } catch (e) {
            log.warn('[arb/trade] Phoenix preflight balance check failed:', e)
          }
        }
      }
    }

    if (preflightErrors.length > 0) {
      await registry.cleanup()
      return c.json({
        status: 'error',
        message: preflightErrors.join('; '),
        error: 'Insufficient balance',
      } as ArbTradeErrorResponse, 400)
    }

    const positions: Record<string, ArbTradeLegResult> = {}

    // Helper to execute a single leg and capture result or error
    async function executeLeg(
      protocol: ArbProtocol,
      direction: 'long' | 'short',
      provider: any
    ): Promise<ArbTradeLegResult> {
      const base: Omit<ArbTradeLegResult, 'status'> = {
        direction,
        margin: marginPerSide,
        notional: notionalUsd,
      }

      const legMkt = marketFor(protocol)
      try {
        if (protocol === 'pacifica') {
          if (!targetSizeAsset) throw new Error(`Cannot compute target size for ${legMkt}`)
          log.info(`[arb/trade] Executing Pacifica ${direction.toUpperCase()}: ${targetSizeAsset} ${legMkt} @ ${leverage}x`)
          const result = await executePacificaOrder(
            embeddedWallet, legMkt, targetSizeAsset, direction, leverage, authContext, pacificaLotSize
          )
          return { ...base, status: 'success', orderId: result.orderId }
        }

        if (protocol === 'hyperliquid') {
          if (!embeddedEthWallet) throw new Error('Ethereum wallet required for Hyperliquid trading')
          log.info(`[arb/trade] Executing Hyperliquid ${direction.toUpperCase()}: ${legMkt} @ ${leverage}x`)
          const result = await executeHyperliquidOrder(
            embeddedEthWallet,
            registry.getHyperliquidProvider() as HyperliquidArbProvider,
            legMkt, marginPerSide, leverage, direction, authContext, targetSizeAsset
          )
          return { ...base, status: 'success', orderId: result.orderId }
        }

        const hip3DexName = parseHip3ProtocolId(protocol)
        if (hip3DexName) {
          if (!embeddedEthWallet) throw new Error(`Ethereum wallet required for ${protocol}`)
          const hip3Provider = registry.getHip3Provider(hip3DexName) as Hip3HyperliquidArbProvider | null
          if (!hip3Provider) throw new Error(`${protocol} provider not available`)
          log.info(`[arb/trade] Executing ${protocol} ${direction.toUpperCase()}: ${legMkt} @ ${leverage}x`)
          const result = await executeHyperliquidOrder(
            embeddedEthWallet,
            hip3Provider,
            legMkt, marginPerSide, leverage, direction, authContext, targetSizeAsset
          )
          return { ...base, status: 'success', orderId: result.orderId }
        }

        if (protocol === 'aster') {
          if (!privyUserId) throw new Error('User ID required for Aster trading')
          log.info(`[arb/trade] Executing Aster ${direction.toUpperCase()}: ${legMkt} @ ${leverage}x`)
          const result = await executeAsterOrder(
            privyUserId,
            embeddedWallet,
            registry.getAsterProvider() as AsterArbProvider,
            legMkt, marginPerSide, leverage, direction, authContext, targetSizeAsset
          )
          return { ...base, status: 'success', orderId: result.orderId }
        }

        if (protocol === 'lighter') {
          if (!privyUserId) throw new Error('User ID required for Lighter trading')
          if (!embeddedEthWallet) throw new Error('Ethereum wallet required for Lighter trading')
          log.info(`[arb/trade] Executing Lighter ${direction.toUpperCase()}: ${legMkt} @ ${leverage}x`)
          const result = await executeLighterOrder(
            privyUserId,
            embeddedEthWallet,
            registry.getLighterProvider() as LighterArbProvider,
            legMkt, marginPerSide, leverage, direction, authContext, targetSizeAsset
          )
          return { ...base, status: 'success', orderId: result.orderId }
        }

        if (protocol === '01') {
          if (!privyUserId) throw new Error('User ID required for 01 trading')
          log.info(`[arb/trade] Executing 01 ${direction.toUpperCase()}: ${legMkt} @ ${leverage}x`)
          const result = await executeZoOrder(
            privyUserId,
            embeddedWallet,
            registry.getZoProvider() as ZoArbProvider,
            legMkt, marginPerSide, leverage, direction, authContext, targetSizeAsset
          )
          return { ...base, status: 'success', orderId: result.orderId }
        }

        if (protocol === 'phoenix') {
          if (!targetSizeAsset) throw new Error(`Cannot compute target size for ${legMkt}`)
          log.info(`[arb/trade] Executing Phoenix ${direction.toUpperCase()}: ${targetSizeAsset} ${legMkt} @ ${leverage}x`)
          const result = await executePhoenixOrder(
            embeddedWallet,
            registry.getPhoenixProvider() as PhoenixArbProvider,
            legMkt, targetSizeAsset, marginPerSide, direction, authContext, phoenixLotSize
          )
          return { ...base, status: 'success', txSignature: result.txSignature }
        }

        throw new Error(`Unsupported protocol: ${protocol}`)
      } catch (error) {
        const rawMsg = error instanceof Error ? error.message : 'Unknown error'
        const cause = error instanceof Error && error.cause ? ` | cause: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}` : ''
        log.error(`[arb/trade] ${protocol} ${direction} failed: ${rawMsg}${cause}`)
        return { ...base, status: 'error', error: sanitizeArbError(rawMsg, protocol) }
      }
    }

    // Execute long leg first
    const longResult = await executeLeg(longProtocol, 'long', longProvider)
    positions[longProtocol] = longResult

    // Execute short leg
    const shortResult = await executeLeg(shortProtocol, 'short', shortProvider)
    positions[shortProtocol] = shortResult

    // Determine overall status
    const bothSucceeded = longResult.status === 'success' && shortResult.status === 'success'
    const bothFailed = longResult.status === 'error' && shortResult.status === 'error'

    // Rollback: if one leg succeeded and the other failed, close/cancel the successful leg
    let rollbackSucceeded = false
    let rollbackError: string | undefined
    if (!bothSucceeded && !bothFailed) {
      const succeededLeg: 'long' | 'short' = longResult.status === 'success' ? 'long' : 'short'
      const succeededProtocol = succeededLeg === 'long' ? longProtocol : shortProtocol
      const succeededProvider = succeededLeg === 'long' ? longProvider : shortProvider

      log.info(`[arb/trade] Rolling back ${succeededProtocol} ${succeededLeg} due to other leg failure`)

      const rollbackMarket = marketFor(succeededProtocol)
      try {
        if (succeededProtocol === 'pacifica') {
          const pacificaProvider = succeededProvider as PacificaArbProvider
          const positions = await pacificaProvider.getPositions(walletPubkey)
          const normalizedSymbol = normalizePacificaSymbol(rollbackMarket)
          const pos = positions.find(p => p.symbol === normalizedSymbol && p.direction === succeededLeg)
          if (!pos) throw new Error(`No Pacifica ${succeededLeg} position found to rollback`)
          const lotSize = pacificaProvider.getLotSize(rollbackMarket)
          await closePacificaPosition(embeddedWallet, rollbackMarket, pos.sizeAsset, succeededLeg, authContext, lotSize)
        } else if (succeededProtocol === '01') {
          await (succeededProvider as ZoArbProvider).executeClose(rollbackMarket, succeededLeg, walletPubkey)
        } else if (succeededProtocol === 'phoenix') {
          if (!targetSizeAsset) throw new Error(`Cannot determine Phoenix close size for ${rollbackMarket}`)
          await closePhoenixPosition(
            embeddedWallet,
            succeededProvider as PhoenixArbProvider,
            rollbackMarket,
            targetSizeAsset,
            succeededLeg,
            authContext,
          )
        } else {
          // HL, Aster, Lighter — credentials already set during trade execution
          await (succeededProvider as { executeClose: (s: string, d: 'long' | 'short') => Promise<any> })
            .executeClose(rollbackMarket, succeededLeg)
        }
        rollbackSucceeded = true
        log.info(`[arb/trade] Rollback successful for ${succeededProtocol} ${succeededLeg}`)
      } catch (error) {
        rollbackError = error instanceof Error ? error.message : String(error)
        log.error(`[arb/trade] Rollback FAILED for ${succeededProtocol} ${succeededLeg}:`, error)
      }
    }

    // Persist to DB (before cleanup so providers are still available for liq price fetch)
    const dbPairId = await persistArbPair({
      embeddedWallet, embeddedEthWallet, privyUserId: privyUserId || '',
      longMarket, shortMarket, marginPerSide, notionalUsd, leverage,
      longProtocol, shortProtocol, longResult, shortResult,
      targetSizeAsset, longProvider, shortProvider, walletPubkey,
      bothSucceeded,
      disableAclp,
      disableAutoclose,
    })

    // Cleanup
    await registry.cleanup()

    let status: 'success' | 'partial' = bothSucceeded ? 'success' : 'partial'
    let message: string
    let httpStatus = 200

    const marketLabel = longMarket === shortMarket ? longMarket : `${longMarket}/${shortMarket}`
    if (bothSucceeded) {
      message = `Arbitrage positions opened on ${marketLabel} (${longProtocol} + ${shortProtocol})`
    } else if (bothFailed) {
      message = `Both legs failed for ${marketLabel}`
      httpStatus = 500
    } else {
      const failedLeg = longResult.status === 'error' ? longProtocol : shortProtocol
      const succeededLeg = longResult.status === 'success' ? longProtocol : shortProtocol
      if (rollbackSucceeded) {
        message = `${failedLeg} failed — ${succeededLeg} position was automatically closed`
      } else {
        message = `${succeededLeg} succeeded but ${failedLeg} failed — rollback failed, unhedged position may be open on ${succeededLeg}`
      }
    }

    const response: ArbTradeSuccessResponse = {
      status,
      message,
      positions,
      fees: { total: 0 },
      pairId: dbPairId,
    }

    return c.json(response, httpStatus as any)
  } catch (error) {
    await registry.cleanup()
    throw error
  }
}

/**
 * Compute a single target size (in asset units) for both arb legs.
 * Uses the coarsest lot size among the two protocols and rounds UP.
 *
 * For cross-ticker pairs (different per-dex tickers for the same underlying
 * asset) the long-leg oracle price is used as the reference. Both dexes price
 * the same underlying so the size is delta-neutral at entry — small per-dex
 * oracle drift is tolerated by the delta-drift close path.
 */
async function computeTargetSize(
  longMarket: string,
  shortMarket: string,
  notionalUsd: number,
  longProtocol: ArbProtocol,
  shortProtocol: ArbProtocol,
  registry: any
): Promise<number | undefined> {
  const [longPrice, shortPrice] = await Promise.all([
    getOraclePriceForProtocol(longProtocol, longMarket),
    getOraclePriceForProtocol(shortProtocol, shortMarket),
  ])
  const refPrice = longPrice ?? shortPrice

  if (!refPrice || refPrice <= 0) return undefined

  // Determine lot step size for each protocol, using that protocol's market
  const getStep = (protocol: ArbProtocol, market: string): number => {
    if (protocol === 'hyperliquid') {
      const hlProvider = registry.getHyperliquidProvider() as HyperliquidArbProvider | null
      const szDecimals = hlProvider?.getSzDecimals(market)
      if (szDecimals !== null && szDecimals !== undefined) return Math.pow(10, -szDecimals)
      return 0.01 // fallback
    }
    if (protocol === 'pacifica') {
      const pacificaProvider = registry.getPacificaProvider() as PacificaArbProvider | null
      return pacificaProvider?.getLotSize(market) ?? 0.01
    }
    if (protocol === 'aster') {
      const asterProvider = registry.getAsterProvider() as AsterArbProvider | null
      return asterProvider?.getLotSize(market) ?? 0.01
    }
    if (protocol === 'lighter') {
      const lighterProvider = registry.getLighterProvider() as LighterArbProvider | null
      return lighterProvider?.getLotSize(market) ?? 0.01
    }
    if (protocol === '01') {
      const zoProvider = registry.getZoProvider() as ZoArbProvider | null
      return zoProvider?.getLotSize(market) ?? 0.01
    }
    if (protocol === 'phoenix') {
      const phoenixProvider = registry.getPhoenixProvider() as PhoenixArbProvider | null
      return phoenixProvider?.getLotSize(market) ?? 0.000001
    }
    const hip3Name = parseHip3ProtocolId(protocol)
    if (hip3Name) {
      const hip3Provider = registry.getHip3Provider(hip3Name) as Hip3HyperliquidArbProvider | null
      const szDecimals = hip3Provider?.getSzDecimals(market)
      if (szDecimals !== null && szDecimals !== undefined) return Math.pow(10, -szDecimals)
      return 0.01
    }
    return 0.000001
  }

  const step = Math.max(getStep(longProtocol, longMarket), getStep(shortProtocol, shortMarket))
  const rawSize = notionalUsd / refPrice
  return Math.ceil(rawSize / step) * step
}

/**
 * Execute a Hyperliquid order using Privy for EIP-712 signing
 */
async function executeHyperliquidOrder(
  embeddedEthWallet: { walletId: string; address: string },
  provider: HyperliquidArbProvider,
  symbol: string,
  marginUsd: number,
  leverage: number,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] },
  sizeAsset?: number
): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
  // Set up viem account for signing via Hyperliquid SDK
  const viemAccount = createHyperliquidViemAccount(embeddedEthWallet.walletId, embeddedEthWallet.address, authContext)
  provider.setViemAccount(viemAccount)

  // Execute the trade
  return provider.executeTrade({
    symbol,
    marginUsd,
    leverage,
    direction,
    sizeAsset,
  })
}

/**
 * Execute an Aster order using HMAC-SHA256 API credentials
 * Uses Solana wallet for Ed25519 auth flow
 */
async function executeAsterOrder(
  privyUserId: string,
  embeddedSolanaWallet: { walletId: string; address: string },
  provider: AsterArbProvider,
  symbol: string,
  marginUsd: number,
  leverage: number,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] },
  sizeAsset?: number
): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
  // Get or create API credentials via Solana Ed25519 auth flow
  const creds = await getOrCreateAsterApiCredentials(
    privyUserId,
    embeddedSolanaWallet.address,
    embeddedSolanaWallet.walletId,
    authContext
  )
  provider.setApiCredentials(creds.apiKey, creds.apiSecret)

  // Execute the trade
  return provider.executeTrade({
    symbol,
    marginUsd,
    leverage,
    direction,
    sizeAsset,
  })
}

/**
 * Execute a 01 (Nord) order via signed protobuf /action.
 * Bootstraps a session with Privy (user_sign = ed25519(hex(raw))) on first
 * use, then signs subsequent PlaceOrder actions with the ephemeral session
 * key held by the provider.
 */
async function executeZoOrder(
  privyUserId: string,
  embeddedSolanaWallet: { walletId: string; address: string },
  provider: ZoArbProvider,
  symbol: string,
  marginUsd: number,
  leverage: number,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] },
  sizeAsset?: number,
): Promise<{ orderId: number; success: boolean }> {
  // Ensure an active session — this may trigger a Privy CreateSession round-trip
  // the first time, or once every 30 days after that.
  const session = await getOrCreateZoSession(
    privyUserId,
    embeddedSolanaWallet.walletId,
    embeddedSolanaWallet.address,
    authContext,
  )
  provider.setSession(session)

  return runWithZoSessionInvalidation(privyUserId, () => provider.executeTrade({
    symbol,
    marginUsd,
    leverage,
    direction,
    sizeAsset,
  }))
}

/**
 * Execute a Lighter order via FFI signer + REST API
 * Uses ETH wallet for EIP-191 signing during API key registration
 */
async function executeLighterOrder(
  privyUserId: string,
  embeddedEthWallet: { walletId: string; address: string },
  provider: LighterArbProvider,
  symbol: string,
  marginUsd: number,
  leverage: number,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] },
  sizeAsset?: number
): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
  // Get or create Lighter API credentials via FFI + ETH signing
  const creds = await getOrCreateLighterApiCredentials(
    privyUserId,
    embeddedEthWallet.address,
    embeddedEthWallet.walletId,
    authContext
  )
  await provider.setCredentials(creds)
  provider.setEthAddress(embeddedEthWallet.address)

  // Execute the trade
  return provider.executeTrade({
    symbol,
    marginUsd,
    leverage,
    direction,
    sizeAsset,
  })
}

/**
 * Execute a Pacifica order using Privy for signing
 * Sets leverage before placing the order and rounds to lot size
 */
async function executePacificaOrder(
  embeddedWallet: { walletId: string; address: string },
  symbol: string,
  sizeAsset: number,
  direction: 'long' | 'short',
  leverage: number,
  authContext: { authorization_private_keys: string[] },
  lotSize: number = 0.01
): Promise<{ orderId: number; success: boolean }> {
  const account = embeddedWallet.address
  const normalizedSymbol = normalizePacificaSymbol(symbol)
  const side = direction === 'long' ? 'bid' : 'ask'

  // Round down to lot size (per-market from tick_size)
  const roundedSize = Math.floor(sizeAsset / lotSize) * lotSize

  if (roundedSize < lotSize) {
    throw new Error(`Order too small. Minimum size is ${lotSize} ${normalizedSymbol}`)
  }

  // Determine decimal places from lot size (e.g., 0.1 -> 1, 0.01 -> 2)
  const decimals = Math.max(0, -Math.floor(Math.log10(lotSize)))
  const amount = roundedSize.toFixed(decimals)

  // Step 0: Claim referral code (idempotent — silently ignored if already claimed)
  try {
    const { message: referralMessage, timestamp: referralTimestamp } = createReferralClaimPayload()
    const referralSignature = await signMessageWithPrivy(
      embeddedWallet.walletId,
      referralMessage,
      authContext
    )
    await claimPacificaReferralCode({
      account,
      signature: referralSignature,
      timestamp: referralTimestamp,
    })
  } catch {
    // Non-fatal — code may already be claimed or account not yet indexed
  }

  // Step 1: Set leverage for this market
  const leverageData = {
    symbol: normalizedSymbol,
    leverage: Math.floor(leverage),
  }
  const { message: leverageMessage, timestamp: leverageTimestamp } = createPacificaPayload(
    'update_leverage',
    leverageData
  )
  const leverageSignature = await signMessageWithPrivy(
    embeddedWallet.walletId,
    leverageMessage,
    authContext
  )
  await setPacificaLeverage({
    account,
    symbol: normalizedSymbol,
    leverage,
    signature: leverageSignature,
    timestamp: leverageTimestamp,
  })

  // Step 2: Set margin mode to isolated
  const marginData = {
    symbol: normalizedSymbol,
    is_isolated: true,
  }
  const { message: marginMessage, timestamp: marginTimestamp } = createPacificaPayload(
    'update_margin_mode',
    marginData
  )
  const marginSignature = await signMessageWithPrivy(
    embeddedWallet.walletId,
    marginMessage,
    authContext
  )
  await setPacificaMarginMode({
    account,
    symbol: normalizedSymbol,
    isIsolated: true,
    signature: marginSignature,
    timestamp: marginTimestamp,
  })

  // Step 3: Create and sign the order payload
  const orderData = {
    symbol: normalizedSymbol,
    amount,
    side,
    slippage_percent: '1.0',
    reduce_only: false,
  }

  const { message, timestamp } = createPacificaPayload('create_market_order', orderData)

  // Sign with Privy
  const signature = await signMessageWithPrivy(
    embeddedWallet.walletId,
    message,
    authContext
  )

  // Step 3: Execute the order
  return executePacificaMarketOrder({
    account,
    symbol: normalizedSymbol,
    amount,
    side,
    reduceOnly: false,
    signature,
    timestamp,
  })
}

/**
 * Execute a Phoenix order: build the place-isolated-market-order tx via the
 * Phoenix HTTP API (which inlines trader-subaccount registration and the
 * collateral transfer), then sign+submit via Privy.
 */
async function executePhoenixOrder(
  embeddedWallet: { walletId: string; address: string },
  provider: PhoenixArbProvider,
  symbol: string,
  sizeAsset: number,
  marginUsd: number,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] },
  lotSize: number = 0.000001,
): Promise<{ txSignature: string; success: boolean }> {
  const roundedSize = Math.floor(sizeAsset / lotSize) * lotSize
  if (roundedSize < lotSize) {
    throw new Error(`Order too small. Minimum size is ${lotSize} ${normalizePhoenixSymbol(symbol)}`)
  }

  const [{ transaction }, { blockhash }] = await Promise.all([
    provider.buildPlaceMarketOrderTransaction({
      symbol,
      direction,
      sizeAsset: roundedSize,
      marginUsd,
      authority: embeddedWallet.address,
    }),
    connection.getLatestBlockhash('finalized'),
  ])
  transaction.recentBlockhash = blockhash

  const serializedTx = serializeTransactionForPrivy(transaction)
  const result = await privy.wallets().solana().signAndSendTransaction(
    embeddedWallet.walletId,
    {
      caip2: SOLANA_CAIP2,
      transaction: serializedTx,
      authorization_context: authContext,
    },
  )
  if (!result.hash) throw new Error('Phoenix trade transaction hash not returned from Privy')
  return { txSignature: result.hash, success: true }
}

/**
 * Sanitize raw error messages from arb providers into user-friendly text.
 * Keeps the log-level detail in server logs but returns clean messages to the frontend.
 */
function sanitizeArbError(rawMsg: string, protocol: string): string {
  const msg = rawMsg.toLowerCase()
  const name = protocol === '01' ? '01' : protocol.charAt(0).toUpperCase() + protocol.slice(1)

  // 01-specific — session bootstrap failures.
  if (msg.includes('no 01 account found') || msg.includes('please deposit funds to 01')) {
    return 'No 01 account found. Please deposit funds on 01 first.'
  }
  if (msg.includes('signature_verification')) {
    return `${name} rejected the signature. Please try again.`
  }
  if (msg.includes('timestamp_out_of_threshold')) {
    return `${name} rejected the request due to clock drift. Please try again.`
  }

  // Prisma / DB credential lookup failures
  if (msg.includes('exchange_api_keys') || msg.includes('undefined is not an object')) {
    return `Failed to retrieve ${name} API credentials. Please try again later.`
  }

  // Account not found
  if (msg.includes('no lighter account found') || msg.includes('no account found')) {
    return `No ${name} account found. Please deposit funds on ${name} first.`
  }

  // Zero balance
  if (msg.includes('zero balance') || msg.includes('has zero balance')) {
    return `Your ${name} account has zero balance. Please deposit funds first.`
  }

  // Insufficient margin / balance
  if (msg.includes('insufficient') && (msg.includes('margin') || msg.includes('balance') || msg.includes('fund'))) {
    return `Insufficient balance on ${name}. Please deposit more funds.`
  }

  // Auth / login failures
  if (msg.includes('login failed') || msg.includes('login error') || msg.includes('auth') && msg.includes('fail')) {
    return `${name} authentication failed. Please try again.`
  }

  // API key creation failures
  if (msg.includes('create-api-key') || msg.includes('create api key') || msg.includes('changepubkey')) {
    return `Failed to set up ${name} API access. Please try again.`
  }

  // Signing failures
  if (msg.includes('failed to sign') || msg.includes('sign') && msg.includes('fail')) {
    return `Transaction signing failed for ${name}. Please try again.`
  }

  // Network / connectivity
  if (msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('network')) {
    return `Could not reach ${name}. Please try again later.`
  }

  // Order rejected by exchange
  if (msg.includes('order rejected') || msg.includes('rejected')) {
    return `Order rejected by ${name}. Please adjust your parameters and try again.`
  }

  // Rate limiting
  if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429')) {
    return `${name} rate limit reached. Please wait a moment and try again.`
  }

  // Wallet not found
  if (msg.includes('wallet required') || msg.includes('wallet not found')) {
    return `${name} requires a linked wallet that was not found on your account.`
  }

  // Size too small
  if (msg.includes('order too small') || msg.includes('too small') || msg.includes('minimum size')) {
    return `Order size too small for ${name}. Please increase your margin or leverage.`
  }

  // Target size computation failure
  if (msg.includes('cannot compute target size')) {
    return `Could not determine order size for this market. Please try a different pair.`
  }

  // Fallback: truncate and clean up, never expose raw JSON or stack traces
  const clean = rawMsg
    .replace(/^Error:\s*/i, '')
    .split('\n')[0]
    .substring(0, 100)

  // If the cleaned message looks like JSON or contains technical internals, use a generic message
  if (clean.startsWith('{') || clean.startsWith('[') || clean.includes('evaluating') || clean.includes('TypeError')) {
    return `${name} order failed. Please try again.`
  }

  return clean || `${name} order failed. Please try again.`
}

/**
 * Find the cached market entry for `(protocol, market)` using that protocol's
 * native symbol normalizer. Callers pluck the field they need (oraclePrice,
 * fundingRate, etc.). Returns null when the market isn't listed on the dex.
 */
async function findMarketEntry(protocol: string, market: string): Promise<any | null> {
  const { pacificaMarkets, hyperliquidMarkets, asterMarkets, lighterMarkets, zoMarkets, phoenixMarkets, hip3Markets } = await getCachedMarketData()
  const upper = market.toUpperCase()
  const hip3 = parseHip3ProtocolId(protocol)
  if (hip3) return hip3Markets[hip3]?.find((m: any) => m.symbol.toUpperCase() === upper) ?? null
  switch (protocol) {
    case 'hyperliquid':
      return hyperliquidMarkets.find(m => m.symbol.toUpperCase() === normalizeHyperliquidSymbol(market).toUpperCase()) ?? null
    case 'pacifica':
      return pacificaMarkets.find(m => m.symbol.toUpperCase() === normalizePacificaSymbol(market).toUpperCase()) ?? null
    case 'aster':
      return asterMarkets.find(m => m.symbol.toUpperCase() === normalizeAsterSymbol(market).toUpperCase()) ?? null
    case 'lighter':
      return lighterMarkets.find(m => m.symbol.toUpperCase() === normalizeLighterSymbol(market).toUpperCase()) ?? null
    case '01':
      return zoMarkets.find((m: any) => m.symbol.toUpperCase() === upper) ?? null
    case 'phoenix':
      return phoenixMarkets.find((m: any) => m.symbol.toUpperCase() === upper) ?? null
    default:
      return null
  }
}

async function getOraclePriceForProtocol(protocol: string, market: string): Promise<number | null> {
  return (await findMarketEntry(protocol, market))?.oraclePrice ?? null
}

/**
 * Compute entry APY from cached funding rates for the given protocols/markets.
 * Matches frontend calculation: spread (per-hour) * 24 * 365 * 100 = APY%
 * Aster/Lighter rates are per-interval (default 8h), so divide by 8.
 */
async function computeEntryApy(
  longMarket: string,
  shortMarket: string,
  longProtocol: string,
  shortProtocol: string,
): Promise<number | null> {
  try {
    const getHourlyRate = async (protocol: string, market: string): Promise<number | null> => {
      const raw = (await findMarketEntry(protocol, market))?.fundingRate
      if (raw == null) return null
      // Aster + Lighter publish per-8h rates; everything else is per-1h.
      return protocol === 'aster' || protocol === 'lighter' ? raw / 8 : raw
    }

    const [longRate, shortRate] = await Promise.all([
      getHourlyRate(longProtocol, longMarket),
      getHourlyRate(shortProtocol, shortMarket),
    ])

    if (longRate == null || shortRate == null) return null

    const spread = Math.abs(shortRate - longRate)
    return spread * 24 * 365 * 100
  } catch (e) {
    log.warn('[arb/trade] Could not compute entry APY:', e)
    return null
  }
}

/**
 * Save arb position pair to DB and fetch liquidation prices
 */
async function persistArbPair(params: {
  embeddedWallet: { walletId: string; address: string }
  embeddedEthWallet: { walletId: string; address: string } | null
  privyUserId: string
  longMarket: string
  shortMarket: string
  marginPerSide: number
  notionalUsd: number
  leverage: number
  longProtocol: string
  shortProtocol: string
  longResult: ArbTradeLegResult
  shortResult: ArbTradeLegResult
  targetSizeAsset?: number
  longProvider?: any
  shortProvider?: any
  walletPubkey?: PublicKey
  bothSucceeded: boolean
  disableAclp?: boolean
  disableAutoclose?: boolean
}): Promise<number | undefined> {
  const {
    embeddedWallet, embeddedEthWallet, privyUserId, longMarket, shortMarket,
    marginPerSide, notionalUsd, leverage,
    longProtocol, shortProtocol, longResult, shortResult,
    targetSizeAsset, longProvider, shortProvider, walletPubkey,
    bothSucceeded,
    disableAclp = false,
    disableAutoclose = false,
  } = params

  // Fetch liquidation prices from positions if both legs succeeded
  let longLiqPrice: number | null = null
  let shortLiqPrice: number | null = null

  if (bothSucceeded && longProvider && shortProvider && walletPubkey) {
    try {
      await new Promise(r => setTimeout(r, 1000))

      const [longPositions, shortPositions] = await Promise.all([
        longProvider.getPositions(walletPubkey),
        shortProvider.getPositions(walletPubkey),
      ])

      const longPos = longPositions.find((p: any) => p.symbol.toUpperCase() === longMarket.toUpperCase())
      const shortPos = shortPositions.find((p: any) => p.symbol.toUpperCase() === shortMarket.toUpperCase())

      longLiqPrice = longPos?.liquidationPrice || null
      shortLiqPrice = shortPos?.liquidationPrice || null
      log.info(`[arb/trade] Fetched liq prices: long=${longLiqPrice}, short=${shortLiqPrice}`)
    } catch (e) {
      log.warn('[arb/trade] Could not fetch liquidation prices:', e)
    }
  }

  const [longOraclePrice, shortOraclePrice, entryApy] = await Promise.all([
    getOraclePriceForProtocol(longProtocol, longMarket),
    getOraclePriceForProtocol(shortProtocol, shortMarket),
    computeEntryApy(longMarket, shortMarket, longProtocol, shortProtocol),
  ])

  // Fallback: compute liquidation prices from trade params if fetch returned null
  // All positions are isolated margin, so formula: margin is exactly what's deposited
  //   Long liq:  (entryPrice * size - margin) / (size * (1 - mmr))
  //   Short liq: (margin + entryPrice * size) / (size * (1 + mmr))
  if (bothSucceeded) {
    const getLegMmr = (protocol: string, market: string, provider: any): number => {
      if (protocol === 'pacifica') {
        // Pacifica: MMR = 1 / (max_leverage * 2)
        const maxLev = provider?.getMaxLeverage?.(market) || 50
        return 1 / (maxLev * 2)
      }
      if (protocol === '01') {
        // 01 exposes mmf directly per market in /info.
        const spec = (provider as ZoArbProvider | null)?.getMarketSpec(market)
        return spec?.mmf ?? 0.05
      }
      if (protocol === 'phoenix') {
        const maxLev = (provider as PhoenixArbProvider | null)?.getMaxLeverage(market) || 20
        return 1 / (maxLev * 2)
      }
      return 0.05 // Hyperliquid default
    }

    const longEntry = longOraclePrice || 0
    const shortEntry = shortOraclePrice || 0
    const refForSize = longEntry || shortEntry
    const sizeAsset = targetSizeAsset || (refForSize > 0 ? notionalUsd / refForSize : 0)

    if (!longLiqPrice && longEntry > 0 && sizeAsset > 0) {
      const mmr = getLegMmr(longProtocol, longMarket, longProvider)
      longLiqPrice = (longEntry * sizeAsset - marginPerSide) / (sizeAsset * (1 - mmr))
      if (longLiqPrice <= 0) longLiqPrice = null
      log.info(`[arb/trade] Computed long liq price (isolated, mmr=${mmr}): ${longLiqPrice}`)
    }

    if (!shortLiqPrice && shortEntry > 0 && sizeAsset > 0) {
      const mmr = getLegMmr(shortProtocol, shortMarket, shortProvider)
      shortLiqPrice = (marginPerSide + shortEntry * sizeAsset) / (sizeAsset * (1 + mmr))
      log.info(`[arb/trade] Computed short liq price (isolated, mmr=${mmr}): ${shortLiqPrice}`)
    }
  }

  try {
    const oracleAtEntry = longOraclePrice || shortOraclePrice || 0
    const [record] = await db.insert(arbPositionPairs).values({
      userPubkey: embeddedWallet.address,
      privyUserId: privyUserId || '',
      embeddedWalletId: embeddedWallet.walletId,
      ethAddress: embeddedEthWallet?.address || null,
      symbol: longMarket,
      longSymbol: longMarket,
      shortSymbol: shortMarket,
      oraclePriceAtEntry: oracleAtEntry,
      entryApy,
      longProtocol,
      longMarginUsd: marginPerSide,
      longNotionalUsd: notionalUsd,
      longLeverage: leverage,
      longEntryPrice: longOraclePrice || 0,
      longTxSignature: longResult.txSignature || null,
      longOrderId: longResult.orderId || null,
      longLiquidationPrice: longLiqPrice,
      longStatus: longResult.status,
      longError: longResult.error || null,
      shortProtocol,
      shortMarginUsd: marginPerSide,
      shortNotionalUsd: notionalUsd,
      shortLeverage: leverage,
      shortEntryPrice: shortOraclePrice || 0,
      shortTxSignature: shortResult.txSignature || null,
      shortOrderId: shortResult.orderId || null,
      shortLiquidationPrice: shortLiqPrice,
      shortStatus: shortResult.status,
      shortError: shortResult.error || null,
      sizeAsset: targetSizeAsset || null,
      totalMarginUsd: marginPerSide * 2,
      active: bothSucceeded,
      status: bothSucceeded ? 'open' : 'error',
      disableAclp,
      disableAutoclose,
    }).returning()
    const pairId = record.id
    log.info(`[arb/trade] Saved arb pair to DB: id=${pairId}`)
    return pairId
  } catch (e) {
    log.error('[arb/trade] DB persist failed:', e)
    return undefined
  }
}
