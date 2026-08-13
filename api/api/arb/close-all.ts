import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import type {
  ArbCloseAllSuccessResponse,
  ArbCloseAllErrorResponse,
  ArbCloseAllProtocolResult,
  ArbProtocol,
} from '../../models/arb'
import { getInitializedProviders } from '@paystream/perps/registry'
import { PacificaArbProvider } from '@paystream/perps/providers/pacifica-provider'
import { AsterArbProvider } from '@paystream/perps/providers/aster-provider'
import { LighterArbProvider } from '@paystream/perps/providers/lighter-provider'
import { PhoenixArbProvider } from '@paystream/perps/providers/phoenix-provider'
import { getHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import { getStoredApiCredentialsAsync } from '../../clients/arb/aster-auth'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../utils/wallet'
import { getAuthorizationContext } from '../../clients/privy'
import {
  closePacificaPosition,
  closeHyperliquidPosition,
  closeAsterPosition,
  closeLighterPosition,
  closeZoPosition,
  closePhoenixPosition,
  sanitizeArbCloseError,
} from './close'
import { log } from '../../utils/log'
import { db } from '@paystream/db'
import { arbPositionPairs } from '@paystream/db/schema'
import { and, eq } from 'drizzle-orm'

function appendProtocolError(result: ArbCloseAllProtocolResult, label: string, error: unknown) {
  const msg = `${label}: ${error instanceof Error ? error.message : 'Unknown error'}`
  result.status = 'error'
  result.error = result.error ? `${result.error}; ${msg}` : msg
}

/**
 * POST /api/arb/close-all
 * Close all open arbitrage positions across all DEX protocols
 */
export async function closeAllHandler(c: Context) {
  let registry = null

  try {
    const authData = c.privyUser

    if (!authData) {
      const response: ArbCloseAllErrorResponse = {
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
      const response: ArbCloseAllErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
      }
      return c.json(response, 400)
    }

    const embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    const walletPubkey = new PublicKey(embeddedWallet.address)
    registry = await getInitializedProviders(walletPubkey, embeddedEthWallet?.address)

    const pacificaProvider = registry.getProvider('pacifica')
    const hyperliquidProvider = registry.getHyperliquidProvider()
    const asterProvider = registry.getAsterProvider()
    const lighterProvider = registry.getLighterProvider()
    const zoProvider = registry.getZoProvider()
    const phoenixProvider = registry.getPhoenixProvider()

    if (lighterProvider && embeddedEthWallet) {
      (lighterProvider as LighterArbProvider).setEthAddress(embeddedEthWallet.address)
    }

    if (asterProvider) {
      const creds = await getStoredApiCredentialsAsync(authData.user.id)
      if (creds) {
        asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)
      }
    }

    const [pacificaPositions, hyperliquidPositions, asterPositions, lighterPositions, zoPositions, phoenixPositions] = await Promise.all([
      pacificaProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }).catch(err => {
        log.error('[arb/close-all] Failed to fetch Pacifica positions:', err instanceof Error ? err.message : err)
        return []
      }) || [],
      hyperliquidProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }).catch(err => {
        log.error('[arb/close-all] Failed to fetch Hyperliquid positions:', err instanceof Error ? err.message : err)
        return []
      }) || [],
      asterProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }).catch(err => {
        log.error('[arb/close-all] Failed to fetch Aster positions:', err instanceof Error ? err.message : err)
        return []
      }) || [],
      lighterProvider && embeddedEthWallet
        ? lighterProvider.getPositionsByEthAddress(embeddedEthWallet.address, { includeTriggerPrices: false }).catch(err => {
            log.error('[arb/close-all] Failed to fetch Lighter positions:', err instanceof Error ? err.message : err)
            return []
          })
        : [],
      zoProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }).catch(err => {
        log.error('[arb/close-all] Failed to fetch 01 positions:', err instanceof Error ? err.message : err)
        return []
      }) || [],
      phoenixProvider?.getPositions(walletPubkey).catch(err => {
        log.error('[arb/close-all] Failed to fetch Phoenix positions:', err instanceof Error ? err.message : err)
        return []
      }) || [],
    ])

    // Fetch HIP-3 positions for each curated dex provider that was initialized
    const hip3Providers = registry.getHip3Providers()
    const hip3PositionEntries: Array<{
      protocolId: ArbProtocol
      dexName: string
      positions: Awaited<ReturnType<NonNullable<typeof hyperliquidProvider>['getPositions']>>
    }> = []

    if (hip3Providers.size > 0) {
      const hip3Results = await Promise.all(
        Array.from(hip3Providers.entries()).map(async ([dexName, provider]) => {
          try {
            const positions = await provider.getPositions(walletPubkey, { includeTriggerPrices: false })
            return { dexName, positions }
          } catch (err) {
            log.error(`[arb/close-all] Failed to fetch HIP-3 ${dexName} positions:`, err instanceof Error ? err.message : err)
            return { dexName, positions: [] as Awaited<ReturnType<NonNullable<typeof hyperliquidProvider>['getPositions']>> }
          }
        }),
      )
      for (const { dexName, positions } of hip3Results) {
        hip3PositionEntries.push({
          protocolId: getHip3ProtocolId(dexName as any),
          dexName,
          positions,
        })
      }
    }

    const hip3TotalPositions = hip3PositionEntries.reduce((n, e) => n + e.positions.length, 0)

    const totalPositionCount = pacificaPositions.length +
      hyperliquidPositions.length + asterPositions.length + lighterPositions.length + zoPositions.length +
      phoenixPositions.length + hip3TotalPositions

    if (totalPositionCount === 0) {
      await registry.cleanup()
      const response: ArbCloseAllErrorResponse = {
        status: 'error',
        message: 'No open positions found across any protocol',
        error: 'No positions to close',
      }
      return c.json(response, 400)
    }

    const hip3Summary = hip3PositionEntries.map(e => `${e.protocolId}=${e.positions.length}`).join(', ') || 'none'
    log.info(`[arb/close-all] Found ${totalPositionCount} positions to close: Pacifica=${pacificaPositions.length}, HL=${hyperliquidPositions.length}, Aster=${asterPositions.length}, Lighter=${lighterPositions.length}, 01=${zoPositions.length}, Phoenix=${phoenixPositions.length}, HIP-3=[${hip3Summary}]`)

    const authContext = getAuthorizationContext()
    const results: ArbCloseAllSuccessResponse['results'] = {}
    let hasFailure = false

    // Close all protocols in parallel — each is independent
    const closePromises: Promise<void>[] = []

    // --- Pacifica ---
    if (pacificaPositions.length > 0) {
      closePromises.push((async () => {
        const result: ArbCloseAllProtocolResult = { status: 'success', closed: [] }
        const pacificaTyped = registry!.getPacificaProvider() as PacificaArbProvider | null

        for (const pos of pacificaPositions) {
          try {
            const lotSize = pacificaTyped?.getLotSize(pos.symbol) ?? 0.01
            const closeResult = await closePacificaPosition(
              embeddedWallet,
              pos.symbol,
              pos.sizeAsset,
              pos.direction,
              authContext,
              lotSize
            )
            result.closed.push({
              symbol: pos.symbol,
              direction: pos.direction,
              pnl: parseFloat(pos.pnl.toFixed(2)),
              orderId: closeResult.orderId,
            })
          } catch (error) {
            log.error(`[arb/close-all] Failed to close Pacifica ${pos.symbol}:`, error instanceof Error ? error.message : error)
            appendProtocolError(result, pos.symbol, error)
            hasFailure = true
          }
        }
        results.pacifica = result
      })())
    }

    // --- Hyperliquid ---
    if (hyperliquidPositions.length > 0 && hyperliquidProvider) {
      closePromises.push((async () => {
        const result: ArbCloseAllProtocolResult = { status: 'success', closed: [] }

        if (!embeddedEthWallet) {
          result.status = 'error'
          result.error = 'Ethereum wallet required for Hyperliquid'
          hasFailure = true
        } else {
          for (const pos of hyperliquidPositions) {
            try {
              const closeResult = await closeHyperliquidPosition(
                embeddedEthWallet,
                hyperliquidProvider,
                pos.symbol,
                pos.direction,
                authContext
              )
              result.closed.push({
                symbol: pos.symbol,
                direction: pos.direction,
                pnl: parseFloat(pos.pnl.toFixed(2)),
                orderId: closeResult.orderId,
              })
            } catch (error) {
              log.error(`[arb/close-all] Failed to close Hyperliquid ${pos.symbol}:`, error instanceof Error ? error.message : error)
              appendProtocolError(result, pos.symbol, error)
              hasFailure = true
            }
          }
        }
        results.hyperliquid = result
      })())
    }

    // --- Aster ---
    if (asterPositions.length > 0 && asterProvider) {
      closePromises.push((async () => {
        const result: ArbCloseAllProtocolResult = { status: 'success', closed: [] }

        for (const pos of asterPositions) {
          try {
            const closeResult = await closeAsterPosition(
              authData.user.id,
              embeddedWallet,
              asterProvider as AsterArbProvider,
              pos.symbol,
              pos.direction,
              authContext
            )
            result.closed.push({
              symbol: pos.symbol,
              direction: pos.direction,
              pnl: parseFloat(pos.pnl.toFixed(2)),
              orderId: closeResult.orderId,
            })
          } catch (error) {
            log.error(`[arb/close-all] Failed to close Aster ${pos.symbol}:`, error instanceof Error ? error.message : error)
            appendProtocolError(result, pos.symbol, error)
            hasFailure = true
          }
        }
        results.aster = result
      })())
    }

    // --- 01 ---
    if (zoPositions.length > 0 && zoProvider) {
      closePromises.push((async () => {
        const result: ArbCloseAllProtocolResult = { status: 'success', closed: [] }

        for (const pos of zoPositions) {
          try {
            const closeResult = await closeZoPosition(
              authData.user.id,
              embeddedWallet,
              zoProvider,
              pos.symbol,
              pos.sizeAsset,
              pos.direction,
              authContext,
            )
            result.closed.push({
              symbol: pos.symbol,
              direction: pos.direction,
              pnl: parseFloat(pos.pnl.toFixed(2)),
              orderId: closeResult.orderId,
            })
          } catch (error) {
            log.error(`[arb/close-all] Failed to close 01 ${pos.symbol}:`, error instanceof Error ? error.message : error)
            appendProtocolError(result, pos.symbol, error)
            hasFailure = true
          }
        }
        results['01'] = result
      })())
    }

    // --- Lighter ---
    if (lighterPositions.length > 0 && lighterProvider) {
      closePromises.push((async () => {
        const result: ArbCloseAllProtocolResult = { status: 'success', closed: [] }

        if (!embeddedEthWallet) {
          result.status = 'error'
          result.error = 'Ethereum wallet required for Lighter'
          hasFailure = true
        } else {
          for (const pos of lighterPositions) {
            try {
              const closeResult = await closeLighterPosition(
                authData.user.id,
                embeddedEthWallet,
                lighterProvider as LighterArbProvider,
                pos.symbol,
                pos.direction,
                authContext
              )
              result.closed.push({
                symbol: pos.symbol,
                direction: pos.direction,
                pnl: parseFloat(pos.pnl.toFixed(2)),
                orderId: closeResult.orderId,
              })
            } catch (error) {
              log.error(`[arb/close-all] Failed to close Lighter ${pos.symbol}:`, error instanceof Error ? error.message : error)
              appendProtocolError(result, pos.symbol, error)
              hasFailure = true
            }
          }
        }
        results.lighter = result
      })())
    }

    // --- Phoenix ---
    if (phoenixPositions.length > 0 && phoenixProvider) {
      closePromises.push((async () => {
        const result: ArbCloseAllProtocolResult = { status: 'success', closed: [] }

        for (const pos of phoenixPositions) {
          try {
            const closeResult = await closePhoenixPosition(
              embeddedWallet,
              phoenixProvider as PhoenixArbProvider,
              pos.symbol,
              pos.sizeAsset,
              pos.direction,
              authContext,
            )
            result.closed.push({
              symbol: pos.symbol,
              direction: pos.direction,
              pnl: parseFloat(pos.pnl.toFixed(2)),
              txSignature: closeResult.txSignature,
            })
          } catch (error) {
            log.error(`[arb/close-all] Failed to close Phoenix ${pos.symbol}:`, error instanceof Error ? error.message : error)
            appendProtocolError(result, pos.symbol, error)
            hasFailure = true
          }
        }
        results.phoenix = result
      })())
    }

    // --- HIP-3 (one bucket per dex: hl:xyz, hl:flx, …) ---
    for (const { protocolId, dexName, positions: hip3Positions } of hip3PositionEntries) {
      if (hip3Positions.length === 0) continue
      closePromises.push((async () => {
        const result: ArbCloseAllProtocolResult = { status: 'success', closed: [] }
        const provider = registry!.getHip3Provider(dexName as any)

        if (!provider) {
          result.status = 'error'
          result.error = `${protocolId} provider not initialized`
          hasFailure = true
        } else if (!embeddedEthWallet) {
          result.status = 'error'
          result.error = `Ethereum wallet required for ${protocolId}`
          hasFailure = true
        } else {
          for (const pos of hip3Positions) {
            try {
              const closeResult = await closeHyperliquidPosition(
                embeddedEthWallet,
                provider,
                pos.symbol,
                pos.direction,
                authContext,
              )
              result.closed.push({
                symbol: pos.symbol,
                direction: pos.direction,
                pnl: parseFloat(pos.pnl.toFixed(2)),
                orderId: closeResult.orderId,
              })
            } catch (error) {
              log.error(`[arb/close-all] Failed to close ${protocolId} ${pos.symbol}:`, error instanceof Error ? error.message : error)
              appendProtocolError(result, pos.symbol, error)
              hasFailure = true
            }
          }
        }
        results[protocolId] = result
      })())
    }

    await Promise.allSettled(closePromises)

    await registry.cleanup()

    // Build PnL lookup: protocol → symbol → pnl (for per-pair DB updates)
    const pnlByProtocolSymbol = new Map<string, Map<string, number>>()
    let totalPnl = 0
    for (const [protocol, result] of Object.entries(results)) {
      if (!result) continue
      const symbolMap = new Map<string, number>()
      for (const closed of result.closed) {
        symbolMap.set(closed.symbol, closed.pnl)
        totalPnl += closed.pnl
      }
      pnlByProtocolSymbol.set(protocol, symbolMap)
    }

    // Mark all active arb pairs as closed with per-pair realized PnL
    try {
      const activePairs = await db.select({
        id: arbPositionPairs.id,
        symbol: arbPositionPairs.symbol,
        longSymbol: arbPositionPairs.longSymbol,
        shortSymbol: arbPositionPairs.shortSymbol,
        longProtocol: arbPositionPairs.longProtocol,
        shortProtocol: arbPositionPairs.shortProtocol,
      })
        .from(arbPositionPairs)
        .where(and(
          eq(arbPositionPairs.userPubkey, embeddedWallet.address),
          eq(arbPositionPairs.active, true),
          eq(arbPositionPairs.status, 'open'),
        ))

      for (const pair of activePairs) {
        // Cross-ticker pairs carry per-leg tickers; fall back to the shared
        // `symbol` for legacy pairs so PnL matching still works.
        const longKey = pair.longSymbol ?? pair.symbol
        const shortKey = pair.shortSymbol ?? pair.symbol
        const longPnl = pnlByProtocolSymbol.get(pair.longProtocol)?.get(longKey) ?? 0
        const shortPnl = pnlByProtocolSymbol.get(pair.shortProtocol)?.get(shortKey) ?? 0
        await db.update(arbPositionPairs)
          .set({
            active: false,
            status: 'closed' as const,
            closeReason: 'manual' as const,
            realizedPnl: parseFloat((longPnl + shortPnl).toFixed(2)),
            closedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(arbPositionPairs.id, pair.id))
      }

      if (activePairs.length > 0) {
        log.info(`[arb/close-all] Updated ${activePairs.length} arb pair(s) as closed`)
      }
    } catch (e) {
      log.error('[arb/close-all] Failed to update arb pairs in DB:', e)
    }

    const closedCount = Object.values(results).reduce((sum, r) => sum + (r?.closed.length || 0), 0)
    const protocolNames = Object.keys(results).join(', ')

    const response: ArbCloseAllSuccessResponse = {
      status: hasFailure ? 'partial' : 'success',
      message: hasFailure
        ? `Closed ${closedCount} of ${totalPositionCount} positions across ${protocolNames}. Some positions failed to close.`
        : `Successfully closed ${closedCount} position(s) across ${protocolNames}`,
      results,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
    }

    return c.json(response)
  } catch (error) {
    log.error('[arb/close-all] Error:', error instanceof Error ? error.message : error)

    if (registry) {
      try {
        await registry.cleanup()
      } catch (cleanupError) {
        log.error('[arb/close-all] Error cleaning up:', cleanupError)
      }
    }

    const errorResponse: ArbCloseAllErrorResponse = {
      status: 'error',
      message: sanitizeArbCloseError(error instanceof Error ? error.message : 'Unknown error'),
    }
    return c.json(errorResponse, 500)
  }
}
