import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import type {
  ArbCloseRequest,
  ArbCloseSuccessResponse,
  ArbCloseErrorResponse,
  ArbProtocol,
} from '../../models/arb'
import { isArbProtocol } from '../../models/arb'
import { getInitializedProviders } from '@paystream/perps/registry'
import { HyperliquidArbProvider, normalizeHyperliquidSymbol } from '@paystream/perps/providers/hyperliquid-provider'
import type { Hip3HyperliquidArbProvider } from '@paystream/perps/providers/hip3-hyperliquid-provider'
import { parseHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import {
  PacificaArbProvider,
  createPacificaPayload,
  executePacificaMarketOrder,
  normalizePacificaSymbol,
} from '@paystream/perps/providers/pacifica-provider'
import { AsterArbProvider, normalizeAsterSymbol } from '@paystream/perps/providers/aster-provider'
import { LighterArbProvider, normalizeLighterSymbol } from '@paystream/perps/providers/lighter-provider'
import { ZoArbProvider } from '@paystream/perps/providers/zo-provider'
import { PhoenixArbProvider, normalizePhoenixSymbol } from '@paystream/perps/providers/phoenix-provider'
import { getOrCreateAsterApiCredentials, getStoredApiCredentialsAsync } from '../../clients/arb/aster-auth'
import { getOrCreateLighterApiCredentials } from '../../clients/arb/lighter-auth'
import { getOrCreateZoSession, runWithZoSessionInvalidation } from '../../clients/arb/zo-auth'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../utils/wallet'
import { resolveLegMarket } from '../../utils/arb-leg'
import { connection } from '../../clients/solana'
import { serializeTransactionForPrivy } from '../../utils/transaction'
import { SOLANA_CAIP2 } from '../../utils/constants'
import { privy, getAuthorizationContext, signMessageWithPrivy, createHyperliquidViemAccount } from '../../clients/privy'
import { log } from '../../utils/log'
import { db } from '@paystream/db'
import { arbPositionPairs } from '@paystream/db/schema'
import { and, desc, eq } from 'drizzle-orm'

/**
 * POST /api/arb/close
 * Close arbitrage positions on both protocols
 */
export async function closeHandler(c: Context) {
  let registry = null

  try {
    const authData = c.privyUser

    if (!authData) {
      const response: ArbCloseErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedWallet) {
      const response: ArbCloseErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
      }
      return c.json(response, 400)
    }

    // Parse request body
    const body = await c.req.json().catch(() => ({})) as ArbCloseRequest
    const { market, protocols, publicId } = body
    let { pairId } = body

    // Validate request
    if (!market) {
      const response: ArbCloseErrorResponse = {
        status: 'error',
        message: 'Market symbol is required',
        error: 'Missing required field: market',
      }
      return c.json(response, 400)
    }

    if (!protocols || !Array.isArray(protocols) || protocols.length === 0) {
      const response: ArbCloseErrorResponse = {
        status: 'error',
        message: 'Protocols array is required',
        error: 'Missing required field: protocols',
      }
      return c.json(response, 400)
    }

    const unsupportedProtocols = protocols.filter(p => !isArbProtocol(p))

    // Refuse to close partially when any leg is on a protocol we no longer
    // support (e.g. legacy Drift pairs). Closing only the supported leg would
    // orphan the other side while marking the pair closed in the DB.
    if (unsupportedProtocols.length > 0) {
      const response: ArbCloseErrorResponse = {
        status: 'error',
        message: `Unsupported protocol(s): ${unsupportedProtocols.join(', ')}. Pair must be closed manually on those exchanges.`,
        error: 'Unsupported protocol',
      }
      if (pairId) {
        try {
          await db.update(arbPositionPairs)
            .set({ closeError: response.message, status: 'error', updatedAt: new Date() })
            .where(eq(arbPositionPairs.id, pairId))
        } catch (e) {
          log.error('[arb/close] Failed to flag pair with closeError:', e)
        }
      }
      return c.json(response, 400)
    }

    const validProtocols = protocols.filter(isArbProtocol)
    if (validProtocols.length === 0) {
      const response: ArbCloseErrorResponse = {
        status: 'error',
        message: 'Invalid protocols. Must be "pacifica", "hyperliquid", "aster", "lighter", "01", or "phoenix"',
        error: 'Invalid protocols',
      }
      return c.json(response, 400)
    }

    // Extract Ethereum wallet for Hyperliquid/Aster/Lighter (if needed)
    const embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    const walletPubkey = new PublicKey(embeddedWallet.address)

    // When pairId is provided, look up the stored per-leg tickers so
    // cross-ticker pairs (e.g. long XAU on Pacifica + short GOLD on HL) can
    // close each leg using its own dex-native symbol. Legacy pairs without
    // per-leg tickers fall back to the shared `market` param.
    let longProtocolFromPair: string | undefined
    let longSymbolFromPair: string | undefined
    let shortProtocolFromPair: string | undefined
    let shortSymbolFromPair: string | undefined
    if (pairId || publicId) {
      try {
        const [pair] = await db.select({
          id: arbPositionPairs.id,
          longProtocol: arbPositionPairs.longProtocol,
          longSymbol: arbPositionPairs.longSymbol,
          shortProtocol: arbPositionPairs.shortProtocol,
          shortSymbol: arbPositionPairs.shortSymbol,
        }).from(arbPositionPairs)
          .where(pairId ? eq(arbPositionPairs.id, pairId) : eq(arbPositionPairs.publicId, publicId!))
          .limit(1)
        if (pair) {
          pairId = pair.id
          longProtocolFromPair = pair.longProtocol
          longSymbolFromPair = pair.longSymbol ?? undefined
          shortProtocolFromPair = pair.shortProtocol
          shortSymbolFromPair = pair.shortSymbol ?? undefined
        } else if (publicId) {
          const response: ArbCloseErrorResponse = {
            status: 'error',
            message: 'Pair not found',
            error: 'Invalid publicId',
          }
          return c.json(response, 404)
        }
      } catch (e) {
        log.warn('[arb/close] Could not look up pair for per-leg symbols:', e)
      }
    }

    const marketFor = (protocol: ArbProtocol): string =>
      resolveLegMarket(protocol, {
        longProtocol: longProtocolFromPair,
        longSymbol: longSymbolFromPair,
        shortProtocol: shortProtocolFromPair,
        shortSymbol: shortSymbolFromPair,
        fallback: market,
      })

    registry = await getInitializedProviders(walletPubkey, embeddedEthWallet?.address, validProtocols)

    // Get current positions to determine which direction to close
    const pacificaProvider = registry.getProvider('pacifica')
    const hyperliquidProvider = registry.getHyperliquidProvider()
    const asterProvider = registry.getAsterProvider()
    const lighterProvider = registry.getLighterProvider()
    const zoProvider = registry.getZoProvider()
    const phoenixProvider = registry.getPhoenixProvider()

    // Set ETH address on Lighter provider so getPositions() can look up by L1 address
    if (lighterProvider && embeddedEthWallet) {
      (lighterProvider as LighterArbProvider).setEthAddress(embeddedEthWallet.address)
    }

    // Set Aster API credentials if available (required for signed position queries)
    if (asterProvider) {
      const creds = await getStoredApiCredentialsAsync(authData.user.id)
      if (creds) {
        asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)
      }
    }

    // Fetch current positions from requested protocols
    const [pacificaPositions, hyperliquidPositions, asterPositions, lighterPositions, zoPositions, phoenixPositions] = await Promise.all([
      validProtocols.includes('pacifica') && pacificaProvider
        ? pacificaProvider.getPositions(walletPubkey)
        : [],
      validProtocols.includes('hyperliquid') && hyperliquidProvider
        ? hyperliquidProvider.getPositions(walletPubkey)
        : [],
      validProtocols.includes('aster') && asterProvider
        ? asterProvider.getPositions(walletPubkey)
        : [],
      validProtocols.includes('lighter') && lighterProvider
        ? lighterProvider.getPositions(walletPubkey)
        : [],
      validProtocols.includes('01') && zoProvider
        ? zoProvider.getPositions(walletPubkey)
        : [],
      validProtocols.includes('phoenix') && phoenixProvider
        ? phoenixProvider.getPositions(walletPubkey)
        : [],
    ])

    // Find positions for each leg using its per-dex ticker
    const pacificaPosition = pacificaPositions.find(
      p => p.symbol.toUpperCase() === normalizePacificaSymbol(marketFor('pacifica')).toUpperCase()
    )
    const hyperliquidPosition = hyperliquidPositions.find(
      p => p.symbol.toUpperCase() === normalizeHyperliquidSymbol(marketFor('hyperliquid')).toUpperCase()
    )
    const asterPosition = asterPositions.find(
      p => p.symbol.toUpperCase() === marketFor('aster').toUpperCase()
    )
    const lighterPosition = lighterPositions.find(
      p => p.symbol.toUpperCase() === normalizeLighterSymbol(marketFor('lighter')).toUpperCase()
    )
    const zoPosition = zoPositions.find(
      p => p.symbol.toUpperCase() === marketFor('01').toUpperCase()
    )
    const phoenixPosition = phoenixPositions.find(
      p => p.symbol.toUpperCase() === marketFor('phoenix').toUpperCase()
    )

    // Track P&L
    let pacificaPnl = 0
    let hyperliquidPnl = 0
    let asterPnl = 0
    let lighterPnl = 0
    let zoPnl = 0
    let phoenixPnl = 0

    const closedProtocols: Partial<Record<ArbProtocol, any>> = {}

    // Get auth context for Privy signing
    const authContext = getAuthorizationContext()

    // Handle Pacifica closing separately (REST API)
    if (validProtocols.includes('pacifica') && pacificaPosition) {
      const pacificaMarket = marketFor('pacifica')
      log.info(`[arb/close] Closing Pacifica ${pacificaPosition.direction} position for ${pacificaMarket}`)

      try {
        // Get per-market lot size from provider
        const pacificaTyped = registry.getPacificaProvider() as PacificaArbProvider | null
        const lotSize = pacificaTyped?.getLotSize(pacificaMarket) ?? 0.01

        const pacificaResult = await closePacificaPosition(
          embeddedWallet,
          pacificaMarket,
          pacificaPosition.sizeAsset,
          pacificaPosition.direction,
          authContext,
          lotSize
        )
        pacificaPnl = pacificaPosition.pnl
        closedProtocols.pacifica = {
          orderId: pacificaResult.orderId,
          direction: pacificaPosition.direction,
          pnl: parseFloat(pacificaPnl.toFixed(2)),
        }
      } catch (error) {
        log.error(`[arb/close] Failed to close Pacifica position:`, error)
        // Continue with other protocols
      }
    }

    // Handle Hyperliquid closing separately (REST API)
    if (validProtocols.includes('hyperliquid') && hyperliquidPosition && hyperliquidProvider) {
      const hlMarket = marketFor('hyperliquid')
      log.info(`[arb/close] Closing Hyperliquid ${hyperliquidPosition.direction} position for ${hlMarket}`)

      if (!embeddedEthWallet) {
        log.error(`[arb/close] Ethereum wallet required for Hyperliquid closing`)
      } else {
        try {
          const hlResult = await closeHyperliquidPosition(
            embeddedEthWallet,
            hyperliquidProvider,
            hlMarket,
            hyperliquidPosition.direction,
            authContext
          )
          hyperliquidPnl = hyperliquidPosition.pnl
          closedProtocols.hyperliquid = {
            orderId: hlResult.orderId,
            direction: hyperliquidPosition.direction,
            pnl: parseFloat(hyperliquidPnl.toFixed(2)),
          }
        } catch (error) {
          log.error(`[arb/close] Failed to close Hyperliquid position:`, error)
          // Continue with other protocols
        }
      }
    }

    // Handle Aster closing separately (REST API)
    if (validProtocols.includes('aster') && asterPosition && asterProvider) {
      const asterMarket = marketFor('aster')
      log.info(`[arb/close] Closing Aster ${asterPosition.direction} position for ${asterMarket}`)

      try {
        const asterResult = await closeAsterPosition(
          authData.user.id,
          embeddedWallet,
          asterProvider as AsterArbProvider,
          asterMarket,
          asterPosition.direction,
          authContext
        )
        asterPnl = asterPosition.pnl
        closedProtocols.aster = {
          orderId: asterResult.orderId,
          direction: asterPosition.direction,
          pnl: parseFloat(asterPnl.toFixed(2)),
        }
      } catch (error) {
        log.error(`[arb/close] Failed to close Aster position:`, error)
        // Continue with other protocols
      }
    }

    // Handle 01 closing (signed /action with session key)
    if (validProtocols.includes('01') && zoPosition && zoProvider) {
      const zoMarket = marketFor('01')
      log.info(`[arb/close] Closing 01 ${zoPosition.direction} position for ${zoMarket}`)

      try {
        const zoResult = await closeZoPosition(
          authData.user.id,
          embeddedWallet,
          zoProvider,
          zoMarket,
          zoPosition.sizeAsset,
          zoPosition.direction,
          authContext,
        )
        zoPnl = zoPosition.pnl
        closedProtocols['01'] = {
          orderId: zoResult.orderId,
          direction: zoPosition.direction,
          pnl: parseFloat(zoPnl.toFixed(2)),
        }
      } catch (error) {
        log.error(`[arb/close] Failed to close 01 position:`, error)
        // Continue with other protocols
      }
    }

    // Handle Phoenix closing (Solana tx, signed via Privy)
    if (validProtocols.includes('phoenix') && phoenixPosition && phoenixProvider) {
      const phoenixMarket = marketFor('phoenix')
      log.info(`[arb/close] Closing Phoenix ${phoenixPosition.direction} position for ${phoenixMarket}`)

      try {
        const phoenixResult = await closePhoenixPosition(
          embeddedWallet,
          phoenixProvider as PhoenixArbProvider,
          phoenixMarket,
          phoenixPosition.sizeAsset,
          phoenixPosition.direction,
          authContext,
        )
        phoenixPnl = phoenixPosition.pnl
        closedProtocols.phoenix = {
          orderId: 0,
          txSignature: phoenixResult.txSignature,
          direction: phoenixPosition.direction,
          pnl: parseFloat(phoenixPnl.toFixed(2)),
        }
      } catch (error) {
        log.error(`[arb/close] Failed to close Phoenix position:`, error)
      }
    }

    // Handle Lighter closing separately (REST API)
    if (validProtocols.includes('lighter') && lighterPosition && lighterProvider) {
      const lighterMarket = marketFor('lighter')
      log.info(`[arb/close] Closing Lighter ${lighterPosition.direction} position for ${lighterMarket}`)

      try {
        if (!embeddedEthWallet) throw new Error('Ethereum wallet required for Lighter trading')
        const lighterResult = await closeLighterPosition(
          authData.user.id,
          embeddedEthWallet,
          lighterProvider as LighterArbProvider,
          lighterMarket,
          lighterPosition.direction,
          authContext
        )
        lighterPnl = lighterPosition.pnl
        closedProtocols.lighter = {
          orderId: lighterResult.orderId,
          direction: lighterPosition.direction,
          pnl: parseFloat(lighterPnl.toFixed(2)),
        }
      } catch (error) {
        log.error(`[arb/close] Failed to close Lighter position:`, error)
        // Continue with other protocols
      }
    }

    let hip3Pnl = 0

    for (const proto of validProtocols) {
      const dexName = parseHip3ProtocolId(proto)
      if (!dexName) continue

      const hip3Provider = registry.getHip3Provider(dexName) as Hip3HyperliquidArbProvider | null
      if (!hip3Provider) {
        log.warn(`[arb/close] HIP-3 provider for ${proto} not initialized; skipping`)
        continue
      }

      if (!embeddedEthWallet) {
        log.error(`[arb/close] Ethereum wallet required for HIP-3 (${proto}) close; skipping`)
        continue
      }

      try {
        const hip3Market = marketFor(proto)
        const positions = await hip3Provider.getPositions(walletPubkey)
        const normalized = hip3Market.toUpperCase().replace(/-PERP$/, '').replace(/-USD$/, '')
        const position = positions.find(p => p.symbol.toUpperCase() === normalized)
        if (!position) continue

        log.info(`[arb/close] Closing ${proto} ${position.direction} position for ${hip3Market}`)

        const hlResult = await closeHyperliquidPosition(
          embeddedEthWallet,
          hip3Provider,
          hip3Market,
          position.direction,
          authContext
        )
        hip3Pnl += position.pnl
        closedProtocols[proto] = {
          orderId: hlResult.orderId,
          direction: position.direction,
          pnl: parseFloat(position.pnl.toFixed(2)),
        }
      } catch (error) {
        log.error(`[arb/close] Failed to close ${proto} position:`, error)
      }
    }

    if (Object.keys(closedProtocols).length === 0) {
      const response: ArbCloseErrorResponse = {
        status: 'error',
        message: `No positions found for ${market} on specified protocols`,
        error: 'No positions to close',
      }
      await registry.cleanup()
      return c.json(response, 400)
    }

    // Cleanup
    await registry.cleanup()

    const totalPnl = pacificaPnl + hyperliquidPnl + asterPnl + lighterPnl + zoPnl + phoenixPnl + hip3Pnl

    // Update arb_position_pairs in DB
    try {
      const updateData = {
        active: false,
        status: 'closed' as const,
        closeReason: 'manual' as const,
        realizedPnl: totalPnl,
        closedAt: new Date(),
        updatedAt: new Date(),
      }

      if (pairId) {
        await db.update(arbPositionPairs)
          .set(updateData)
          .where(eq(arbPositionPairs.id, pairId))
        log.info(`[arb/close] Updated arb pair id=${pairId} as closed`)
      } else {
        // Fallback: match by user + market + active
        const [match] = await db.select().from(arbPositionPairs)
          .where(and(
            eq(arbPositionPairs.userPubkey, embeddedWallet.address),
            eq(arbPositionPairs.symbol, market),
            eq(arbPositionPairs.active, true),
            eq(arbPositionPairs.status, 'open'),
          ))
          .orderBy(desc(arbPositionPairs.createdAt))
          .limit(1)
        if (match) {
          await db.update(arbPositionPairs)
            .set(updateData)
            .where(eq(arbPositionPairs.id, match.id))
          log.info(`[arb/close] Updated arb pair id=${match.id} (matched by user+market) as closed`)
        }
      }
    } catch (e) {
      log.error('[arb/close] Failed to update arb pair in DB:', e)
    }

    const response: ArbCloseSuccessResponse = {
      status: 'success',
      message: `Closed ${market} positions on ${Object.keys(closedProtocols).join(' and ')}`,
      closed: closedProtocols,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      bundleId: '', // REST-based orders don't have bundle IDs
    }

    return c.json(response)
  } catch (error) {
    log.error('[arb/close] Error:', error instanceof Error ? error.message : error)

    if (registry) {
      try {
        await registry.cleanup()
      } catch (cleanupError) {
        log.error('[arb/close] Error cleaning up:', cleanupError)
      }
    }

    const rawMsg = error instanceof Error ? error.message : 'Unknown error'
    const errorResponse: ArbCloseErrorResponse = {
      status: 'error',
      message: sanitizeArbCloseError(rawMsg),
    }
    return c.json(errorResponse, 500)
  }
}

/**
 * Close a Pacifica position using Privy for signing
 */
export async function closePacificaPosition(
  embeddedWallet: { walletId: string; address: string },
  symbol: string,
  sizeAsset: number,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] },
  lotSize: number = 0.01
): Promise<{ orderId: number; success: boolean }> {
  const account = embeddedWallet.address
  const normalizedSymbol = normalizePacificaSymbol(symbol)
  // Opposite side to close position
  const side = direction === 'long' ? 'ask' : 'bid'

  // Round to nearest lot size (per-market from tick_size)
  const roundedSize = Math.round(sizeAsset / lotSize) * lotSize // Round to nearest for closing
  const decimals = Math.max(0, -Math.floor(Math.log10(lotSize)))
  const amount = roundedSize.toFixed(decimals)

  // Create the payload to be signed
  const orderData = {
    symbol: normalizedSymbol,
    amount,
    side,
    slippage_percent: '1.0',
    reduce_only: true, // Important: reduce_only for closing
  }

  const { message, timestamp } = createPacificaPayload('create_market_order', orderData)

  log.info(`[arb/close] Signing Pacifica close order: ${amount} ${normalizedSymbol} (${direction} -> ${side})`)

  // Sign with Privy
  const signature = await signMessageWithPrivy(
    embeddedWallet.walletId,
    message,
    authContext
  )

  // Execute the close order
  return executePacificaMarketOrder({
    account,
    symbol: normalizedSymbol,
    amount,
    side,
    reduceOnly: true,
    signature,
    timestamp,
  })
}

/**
 * Close a Hyperliquid position using Privy for EIP-712 signing
 */
export async function closeHyperliquidPosition(
  embeddedEthWallet: { walletId: string; address: string },
  provider: HyperliquidArbProvider,
  symbol: string,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] }
): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
  // Set up viem account for signing via Hyperliquid SDK
  const viemAccount = createHyperliquidViemAccount(embeddedEthWallet.walletId, embeddedEthWallet.address, authContext)
  provider.setViemAccount(viemAccount)

  // Execute the close
  return provider.executeClose(symbol, direction)
}

/**
 * Close an Aster position using HMAC-SHA256 API credentials
 */
export async function closeAsterPosition(
  privyUserId: string,
  embeddedWallet: { walletId: string; address: string },
  provider: AsterArbProvider,
  symbol: string,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] }
): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
  // Get or create API credentials via Solana Ed25519 auth flow
  const creds = await getOrCreateAsterApiCredentials(
    privyUserId,
    embeddedWallet.address,
    embeddedWallet.walletId,
    authContext
  )
  provider.setApiCredentials(creds.apiKey, creds.apiSecret)

  // Execute the close
  return provider.executeClose(symbol, direction)
}

/**
 * Close a 01 (Nord) position via signed protobuf /action.
 * Ensures a session exists (bootstraps via Privy on first call), then
 * submits a reduce-only IOC market order signed with the session key.
 * Takes sizeAsset directly to avoid the /user → /account round-trip that
 * `provider.executeClose()` would do internally to look the position up.
 */
export async function closeZoPosition(
  privyUserId: string,
  embeddedSolanaWallet: { walletId: string; address: string },
  provider: ZoArbProvider,
  symbol: string,
  sizeAsset: number,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] },
): Promise<{ orderId: number; success: boolean }> {
  const session = await getOrCreateZoSession(
    privyUserId,
    embeddedSolanaWallet.walletId,
    embeddedSolanaWallet.address,
    authContext,
  )
  provider.setSession(session)

  return runWithZoSessionInvalidation(privyUserId, () => provider.executeTrade({
    symbol,
    marginUsd: 0,
    leverage: 1,
    direction: direction === 'long' ? 'short' : 'long',
    sizeAsset,
    reduceOnly: true,
  }))
}

/**
 * Close a Lighter position via FFI signer + REST API
 */
export async function closeLighterPosition(
  privyUserId: string,
  embeddedEthWallet: { walletId: string; address: string },
  provider: LighterArbProvider,
  symbol: string,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] }
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

  // Execute the close
  return provider.executeClose(symbol, direction)
}

/**
 * Close a Phoenix position by submitting an opposite-side reduce-only
 * isolated market order. The HTTP API resolves the existing isolated
 * subaccount for the asset; the freed collateral returns to the main pool
 * once the close fills.
 */
export async function closePhoenixPosition(
  embeddedWallet: { walletId: string; address: string },
  provider: PhoenixArbProvider,
  symbol: string,
  sizeAsset: number,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] },
): Promise<{ txSignature: string; success: boolean }> {
  const lotSize = provider.getLotSize(symbol)
  const roundedSize = Math.round(sizeAsset / lotSize) * lotSize
  if (roundedSize < lotSize) {
    throw new Error(`Order too small. Minimum size is ${lotSize} ${normalizePhoenixSymbol(symbol)}`)
  }

  const [{ transaction }, { blockhash }] = await Promise.all([
    provider.buildCloseMarketOrderTransaction({
      symbol,
      direction,
      sizeAsset: roundedSize,
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
  if (!result.hash) throw new Error('Phoenix close transaction hash not returned from Privy')
  return { txSignature: result.hash, success: true }
}

/**
 * Sanitize raw error messages for the close endpoint frontend response.
 */
export function sanitizeArbCloseError(rawMsg: string): string {
  const msg = rawMsg.toLowerCase()

  if (msg.includes('exchange_api_keys') || msg.includes('undefined is not an object')) {
    return 'Failed to retrieve API credentials. Please try again later.'
  }
  if (msg.includes('no lighter account found') || msg.includes('no account found')) {
    return 'Exchange account not found. Please ensure your account is set up.'
  }
  if (msg.includes('insufficient') && (msg.includes('margin') || msg.includes('balance') || msg.includes('fund'))) {
    return 'Insufficient balance to close position.'
  }
  if (msg.includes('position not found') || msg.includes('no position')) {
    return 'Position not found. It may have already been closed.'
  }
  if (msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('network')) {
    return 'Could not reach the exchange. Please try again later.'
  }
  if (msg.includes('wallet required') || msg.includes('wallet not found')) {
    return 'Required wallet not found on your account.'
  }

  const clean = rawMsg.replace(/^Error:\s*/i, '').split('\n')[0].substring(0, 100)
  if (clean.startsWith('{') || clean.startsWith('[') || clean.includes('evaluating') || clean.includes('TypeError')) {
    return 'Failed to close positions. Please try again.'
  }
  return clean || 'Failed to close positions. Please try again.'
}
