import { PublicKey } from '@solana/web3.js'
import { isArbProtocol, type ArbProtocol } from '../models/arb'
import { getInitializedProviders } from '@paystream/perps/registry'
import { HyperliquidArbProvider, normalizeHyperliquidSymbol } from '@paystream/perps/providers/hyperliquid-provider'
import { Hip3HyperliquidArbProvider } from '@paystream/perps/providers/hip3-hyperliquid-provider'
import { parseHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import {
  PacificaArbProvider,
  createPacificaPayload,
  executePacificaMarketOrder,
  normalizePacificaSymbol,
} from '@paystream/perps/providers/pacifica-provider'
import { AsterArbProvider } from '@paystream/perps/providers/aster-provider'
import { LighterArbProvider, normalizeLighterSymbol } from '@paystream/perps/providers/lighter-provider'
import { ZoArbProvider, baseFromZoSymbol } from '@paystream/perps/providers/zo-provider'
import { getOrCreateAsterApiCredentials } from '../clients/arb/aster-auth'
import { getOrCreateLighterApiCredentials } from '../clients/arb/lighter-auth'
import { closeZoPosition } from '../api/arb/close'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../utils/wallet'
import { resolveLegMarket } from '../utils/arb-leg'
import { privy, getAuthorizationContext, signMessageWithPrivy, createHyperliquidViemAccount } from '../clients/privy'
import { db } from '@paystream/db'
import { arbPositionPairs } from '@paystream/db/schema'
import { eq } from 'drizzle-orm'
import { log } from '../utils/log'

export interface ArbCloseParams {
  privyUserId: string
  /** Shared ticker (back-compat). For cross-ticker pairs this is the long
   *  leg's ticker; per-leg overrides take precedence when supplied. */
  market: string
  protocols: string[]
  pairId?: number
  closeReason?: string
  /** Per-leg ticker overrides for cross-ticker pairs. When set, each leg's
   *  position lookup uses its own ticker on its own dex. */
  longProtocol?: string
  longSymbol?: string
  shortProtocol?: string
  shortSymbol?: string
}

export interface ArbCloseResult {
  success: boolean
  totalPnl?: number
  error?: string
}

/**
 * Execute an arb close on behalf of a user.
 * Used by both the user-facing close handler and the internal worker endpoint.
 */
export async function executeArbClose(params: ArbCloseParams): Promise<ArbCloseResult> {
  const { privyUserId, market, protocols, pairId, closeReason } = params
  let { longProtocol, longSymbol, shortProtocol, shortSymbol } = params

  // Backfill per-leg fields from the pair row when caller didn't supply them.
  // Guards against any caller that forgets these for cross-ticker pairs —
  // without them, every leg would resolve to `market` and only the long leg
  // would close.
  if (pairId && (!longProtocol || !shortProtocol || !longSymbol || !shortSymbol)) {
    try {
      const [pair] = await db.select({
        longProtocol: arbPositionPairs.longProtocol,
        longSymbol: arbPositionPairs.longSymbol,
        shortProtocol: arbPositionPairs.shortProtocol,
        shortSymbol: arbPositionPairs.shortSymbol,
      }).from(arbPositionPairs).where(eq(arbPositionPairs.id, pairId)).limit(1)
      if (pair) {
        longProtocol = longProtocol ?? pair.longProtocol
        shortProtocol = shortProtocol ?? pair.shortProtocol
        longSymbol = longSymbol ?? pair.longSymbol ?? undefined
        shortSymbol = shortSymbol ?? pair.shortSymbol ?? undefined
      }
    } catch (e) {
      log.warn(`[arb-close-executor] Could not backfill per-leg fields for pair=${pairId}:`, e)
    }
  }

  const marketFor = (protocol: ArbProtocol): string =>
    resolveLegMarket(protocol, { longProtocol, longSymbol, shortProtocol, shortSymbol, fallback: market })

  let registry = null

  try {
    // Load user from Privy by user ID to get wallet info
    const user = await privy.users()._get(privyUserId)
    if (!user) {
      return { success: false, error: 'User not found in Privy' }
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(user.linked_accounts || [])
    if (!embeddedWallet) {
      return { success: false, error: 'No embedded Solana wallet found' }
    }

    const embeddedEthWallet = extractEmbeddedEthWallet(user.linked_accounts || [])

    const walletPubkey = new PublicKey(embeddedWallet.address)
    const unsupportedProtocols = protocols.filter(p => !isArbProtocol(p))

    // Refuse to touch the pair if any leg is on a protocol we no longer support
    // (e.g. legacy Drift pairs). Closing only the supported leg would orphan the
    // other side while marking the pair closed in the DB.
    if (unsupportedProtocols.length > 0) {
      const errorMsg = `Unsupported protocol(s): ${unsupportedProtocols.join(', ')}. Pair must be closed manually on those exchanges.`
      log.warn(`[arb-close-executor] Rejecting close for pair=${pairId} ${market}: ${errorMsg}`)
      if (pairId) {
        try {
          await db.update(arbPositionPairs)
            .set({ closeError: errorMsg, status: 'error', updatedAt: new Date() })
            .where(eq(arbPositionPairs.id, pairId))
        } catch (e) {
          log.error('[arb-close-executor] Failed to flag pair with closeError:', e)
        }
      }
      return { success: false, error: errorMsg }
    }

    const validProtocols = protocols.filter(isArbProtocol)
    if (validProtocols.length === 0) {
      return { success: false, error: 'No valid protocols specified' }
    }

    registry = await getInitializedProviders(walletPubkey, embeddedEthWallet?.address, validProtocols)

    const pacificaProvider = registry.getProvider('pacifica')
    const hyperliquidProvider = registry.getHyperliquidProvider()
    const asterProvider = registry.getAsterProvider()
    const lighterProvider = registry.getLighterProvider()
    const zoProvider = registry.getZoProvider()

    // Set ETH address on Lighter provider for position fetching
    if (lighterProvider && embeddedEthWallet) {
      ;(lighterProvider as LighterArbProvider).setEthAddress(embeddedEthWallet.address)
    }

    // Set Aster credentials before fetching positions
    if (asterProvider && validProtocols.includes('aster')) {
      try {
        const authContext = getAuthorizationContext()
        const creds = await getOrCreateAsterApiCredentials(privyUserId, embeddedWallet.address, embeddedWallet.walletId, authContext)
        ;(asterProvider as AsterArbProvider).setApiCredentials(creds.apiKey, creds.apiSecret)
      } catch (e) {
        log.warn('[arb-close-executor] Could not load Aster credentials, skipping Aster positions')
      }
    }

    // Fetch current positions
    const [pacificaPositions, hyperliquidPositions, asterPositions, lighterPositions, zoPositions] = await Promise.all([
      validProtocols.includes('pacifica') && pacificaProvider ? pacificaProvider.getPositions(walletPubkey) : [],
      validProtocols.includes('hyperliquid') && hyperliquidProvider ? hyperliquidProvider.getPositions(walletPubkey) : [],
      validProtocols.includes('aster') && asterProvider ? asterProvider.getPositions(walletPubkey) : [],
      validProtocols.includes('lighter') && lighterProvider ? lighterProvider.getPositions(walletPubkey) : [],
      validProtocols.includes('01') && zoProvider ? zoProvider.getPositions(walletPubkey) : [],
    ])

    const pacificaPosition = pacificaPositions.find(p => p.symbol.toUpperCase() === normalizePacificaSymbol(marketFor('pacifica')).toUpperCase())
    const hyperliquidPosition = hyperliquidPositions.find(p => p.symbol.toUpperCase() === normalizeHyperliquidSymbol(marketFor('hyperliquid')).toUpperCase())
    const asterPosition = asterPositions.find(p => p.symbol.toUpperCase() === marketFor('aster').toUpperCase())
    const lighterPosition = lighterPositions.find(p => p.symbol.toUpperCase() === normalizeLighterSymbol(marketFor('lighter')).toUpperCase())
    const zoPosition = zoPositions.find(p => p.symbol.toUpperCase() === baseFromZoSymbol(marketFor('01')).toUpperCase())

    let totalPnl = 0
    const authContext = getAuthorizationContext()
    const legErrors: string[] = []

    // Close Pacifica
    if (validProtocols.includes('pacifica') && pacificaPosition) {
      try {
        const pacificaTyped = registry.getPacificaProvider() as PacificaArbProvider | null
        const pacificaMarket = marketFor('pacifica')
        const lotSize = pacificaTyped?.getLotSize(pacificaMarket) ?? 0.01
        await closePacificaPosition(embeddedWallet, pacificaMarket, pacificaPosition.sizeAsset, pacificaPosition.direction, authContext, lotSize)
        totalPnl += pacificaPosition.pnl
      } catch (error) {
        log.error('[arb-close-executor] Pacifica close failed:', error)
        legErrors.push(`pacifica: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (validProtocols.includes('pacifica') && !pacificaPosition) {
      legErrors.push('pacifica: position not found on exchange')
    }

    // Close Hyperliquid
    if (validProtocols.includes('hyperliquid') && hyperliquidPosition && hyperliquidProvider && embeddedEthWallet) {
      try {
        const viemAccount = createHyperliquidViemAccount(embeddedEthWallet.walletId, embeddedEthWallet.address, authContext)
        ;(hyperliquidProvider as HyperliquidArbProvider).setViemAccount(viemAccount)
        await (hyperliquidProvider as HyperliquidArbProvider).executeClose(marketFor('hyperliquid'), hyperliquidPosition.direction)
        totalPnl += hyperliquidPosition.pnl
      } catch (error) {
        log.error('[arb-close-executor] Hyperliquid close failed:', error)
        legErrors.push(`hyperliquid: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (validProtocols.includes('hyperliquid') && !hyperliquidPosition) {
      legErrors.push('hyperliquid: position not found on exchange')
    }

    // Close Aster (credentials already set above)
    if (validProtocols.includes('aster') && asterPosition && asterProvider) {
      try {
        await (asterProvider as AsterArbProvider).executeClose(marketFor('aster'), asterPosition.direction)
        totalPnl += asterPosition.pnl
      } catch (error) {
        log.error('[arb-close-executor] Aster close failed:', error)
        legErrors.push(`aster: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (validProtocols.includes('aster') && !asterPosition) {
      legErrors.push('aster: position not found on exchange')
    }

    // Close 01 (session-signed /action; closeZoPosition bootstraps or reuses a session)
    if (validProtocols.includes('01') && zoPosition && zoProvider) {
      try {
        await closeZoPosition(
          privyUserId,
          embeddedWallet,
          zoProvider as ZoArbProvider,
          marketFor('01'),
          zoPosition.sizeAsset,
          zoPosition.direction,
          authContext,
        )
        totalPnl += zoPosition.pnl
      } catch (error) {
        log.error('[arb-close-executor] 01 close failed:', error)
        legErrors.push(`01: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (validProtocols.includes('01') && !zoPosition) {
      legErrors.push('01: position not found on exchange')
    }

    // Close HIP-3 Hyperliquid dexes (e.g. hl:xyz, hl:km). Each requires the
    // ETH wallet and reuses the same signing path as main Hyperliquid.
    for (const proto of validProtocols) {
      const hip3Name = parseHip3ProtocolId(proto)
      if (!hip3Name) continue
      if (!embeddedEthWallet) {
        legErrors.push(`${proto}: Ethereum wallet required`)
        continue
      }
      try {
        const hip3Provider = registry.getHip3Provider(hip3Name) as Hip3HyperliquidArbProvider | null
        if (!hip3Provider) {
          legErrors.push(`${proto}: provider unavailable`)
          continue
        }
        const hip3Market = marketFor(proto)
        const hip3Positions = await hip3Provider.getPositions(walletPubkey)
        const hip3Pos = hip3Positions.find(p => p.symbol.toUpperCase() === hip3Market.toUpperCase())
        if (!hip3Pos) {
          legErrors.push(`${proto}: position not found on exchange`)
          continue
        }
        const viemAccount = createHyperliquidViemAccount(embeddedEthWallet.walletId, embeddedEthWallet.address, authContext)
        hip3Provider.setViemAccount(viemAccount)
        await hip3Provider.executeClose(hip3Market, hip3Pos.direction)
        totalPnl += hip3Pos.pnl
      } catch (error) {
        log.error(`[arb-close-executor] ${proto} close failed:`, error)
        legErrors.push(`${proto}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Close Lighter (uses ETH wallet for FFI signing)
    if (validProtocols.includes('lighter') && lighterPosition && lighterProvider && embeddedEthWallet) {
      try {
        const creds = await getOrCreateLighterApiCredentials(privyUserId, embeddedEthWallet.address, embeddedEthWallet.walletId, authContext)
        await (lighterProvider as LighterArbProvider).setCredentials(creds)
        ;(lighterProvider as LighterArbProvider).setEthAddress(embeddedEthWallet.address)
        await (lighterProvider as LighterArbProvider).executeClose(marketFor('lighter'), lighterPosition.direction)
        totalPnl += lighterPosition.pnl
      } catch (error) {
        log.error('[arb-close-executor] Lighter close failed:', error)
        legErrors.push(`lighter: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (validProtocols.includes('lighter') && !lighterPosition) {
      legErrors.push('lighter: position not found on exchange')
    }

    await registry.cleanup()

    // Any failed/missing leg leaves status='closing' so the producer's retry
    // loop takes over — never mark a pair closed with an orphan leg.
    const anyLegFailed = legErrors.length > 0

    // Update DB
    if (pairId) {
      try {
        if (anyLegFailed) {
          await db.update(arbPositionPairs)
            .set({
              closeError: legErrors.join('; '),
              updatedAt: new Date(),
            })
            .where(eq(arbPositionPairs.id, pairId))
          log.warn(`[arb-close-executor] pair=${pairId}: ${legErrors.length}/${validProtocols.length} legs failed — leaving status='closing' for retry: ${legErrors.join('; ')}`)
        } else {
          await db.update(arbPositionPairs)
            .set({
              active: false,
              status: 'closed',
              closeReason: (closeReason as any) || 'manual',
              realizedPnl: totalPnl,
              closedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(arbPositionPairs.id, pairId))
          log.info(`[arb-close-executor] Updated pair id=${pairId} as closed (reason=${closeReason || 'manual'})`)
        }
      } catch (e) {
        log.error('[arb-close-executor] DB update failed:', e)
      }
    }

    if (anyLegFailed) {
      return {
        success: false,
        totalPnl,
        error: legErrors.length === validProtocols.length
          ? `All legs failed: ${legErrors.join('; ')}`
          : `Partial close — some legs failed: ${legErrors.join('; ')}`,
      }
    }

    return { success: true, totalPnl }
  } catch (error) {
    if (registry) {
      try { await registry.cleanup() } catch {}
    }
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    log.error('[arb-close-executor] Error:', errorMsg)
    return { success: false, error: errorMsg }
  }
}

/**
 * Close a Pacifica position (same logic as close.ts)
 */
async function closePacificaPosition(
  embeddedWallet: { walletId: string; address: string },
  symbol: string,
  sizeAsset: number,
  direction: 'long' | 'short',
  authContext: { authorization_private_keys: string[] },
  lotSize: number = 0.01
): Promise<{ orderId: number; success: boolean }> {
  const account = embeddedWallet.address
  const normalizedSymbol = normalizePacificaSymbol(symbol)
  const side = direction === 'long' ? 'ask' : 'bid'

  const roundedSize = Math.round(sizeAsset / lotSize) * lotSize
  const decimals = Math.max(0, -Math.floor(Math.log10(lotSize)))
  const amount = roundedSize.toFixed(decimals)

  const orderData = {
    symbol: normalizedSymbol,
    amount,
    side,
    slippage_percent: '1.0',
    reduce_only: true,
  }

  const { message, timestamp } = createPacificaPayload('create_market_order', orderData)
  const signature = await signMessageWithPrivy(embeddedWallet.walletId, message, authContext)

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
