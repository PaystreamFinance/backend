import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import type {
  ArbPositionsSuccessResponse,
  ArbPositionsErrorResponse,
  ArbPositionInfo,
} from '../../models/arb'
import { getInitializedProviders } from '@paystream/perps/registry'
import { getHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import { getStoredApiCredentialsAsync } from '../../clients/arb/aster-auth'
import { applyLighterReadCredentials } from '../../clients/arb/lighter-auth'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../utils/wallet'
import { log } from '../../utils/log'

/**
 * GET /api/arb/positions
 * Fetch open arbitrage positions from all protocols
 */
export async function positionsHandler(c: Context) {
  let registry = null

  try {
    const authData = c.privyUser

    if (!authData) {
      const response: ArbPositionsErrorResponse = {
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
      const response: ArbPositionsErrorResponse = {
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

    const asterProvider = registry.getAsterProvider()
    const lighterProvider = registry.getLighterProvider()
    const pacificaProvider = registry.getProvider('pacifica')
    const hyperliquidProvider = registry.getProvider('hyperliquid')
    const zoProvider = registry.getZoProvider()
    const phoenixProvider = registry.getPhoenixProvider()

    // Set Aster API credentials if available (required for signed position queries)
    if (asterProvider) {
      const creds = await getStoredApiCredentialsAsync(authData.user.id)
      if (creds) {
        asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)
      }
    }

    if (lighterProvider && embeddedEthWallet) {
      await applyLighterReadCredentials(lighterProvider, authData.user.id, embeddedEthWallet.address)
    }

    // Fetch positions from all providers in parallel
    // Aster returns [] if no credentials are set (positions require signed access)
    const [asterPositions, lighterPositions, pacificaPositions, hyperliquidPositions, zoPositions, phoenixPositions] = await Promise.all([
      asterProvider?.getPositions(walletPubkey) || [],
      lighterProvider && embeddedEthWallet
        ? lighterProvider.getPositionsByEthAddress(embeddedEthWallet.address)
        : [],
      pacificaProvider?.getPositions(walletPubkey) || [],
      hyperliquidProvider?.getPositions(walletPubkey) || [],
      zoProvider?.getPositions(walletPubkey) || [],
      phoenixProvider?.getPositions(walletPubkey) || [],
    ])

    // Transform to response format
    const toPositionInfo = (pos: typeof asterPositions[number]): ArbPositionInfo => ({
      symbol: pos.symbol,
      direction: pos.direction,
      size: { usd: pos.sizeUsd, asset: pos.sizeAsset },
      pnl: pos.pnl,
      unrealizedPnl: pos.unrealizedPnl,
      fundingIncome: pos.fundingIncome,
      entryPrice: pos.entryPrice,
      leverage: pos.leverage,
      margin: pos.margin,
      liquidationPrice: pos.liquidationPrice,
      triggerPrices: pos.triggerPrices,
    })

    const asterPositionInfos = asterPositions.map(toPositionInfo)
    const lighterPositionInfos = lighterPositions.map(toPositionInfo)
    const pacificaPositionInfos = pacificaPositions.map(toPositionInfo)
    const hyperliquidPositionInfos = hyperliquidPositions.map(toPositionInfo)
    const zoPositionInfos = zoPositions.map(toPositionInfo)
    const phoenixPositionInfos = phoenixPositions.map(toPositionInfo)

    // Fetch HIP-3 positions from each curated dex provider (requires ETH wallet;
    // if missing, skip gracefully).
    const hip3Providers = registry.getHip3Providers()
    const hip3Entries = Array.from(hip3Providers.entries())
    const hip3Results = embeddedEthWallet
      ? await Promise.all(hip3Entries.map(async ([dexName, provider]) => {
          try {
            return { dexName, positions: await provider.getPositions(walletPubkey) }
          } catch (err) {
            log.error(`[arb/positions] Failed to fetch HIP-3 ${dexName} positions:`, err instanceof Error ? err.message : err)
            return { dexName, positions: [] as typeof asterPositions }
          }
        }))
      : []

    const positionsByProtocol: ArbPositionsSuccessResponse['positions'] = {
      aster: asterPositionInfos,
      lighter: lighterPositionInfos,
      pacifica: pacificaPositionInfos,
      hyperliquid: hyperliquidPositionInfos,
      '01': zoPositionInfos,
      phoenix: phoenixPositionInfos,
    }
    let hip3TotalPnl = 0
    for (const { dexName, positions } of hip3Results) {
      positionsByProtocol[getHip3ProtocolId(dexName)] = positions.map(toPositionInfo)
      for (const pos of positions) hip3TotalPnl += pos.pnl
    }

    // Calculate total P&L
    const totalPnl = [...asterPositions, ...lighterPositions, ...pacificaPositions, ...hyperliquidPositions, ...zoPositions, ...phoenixPositions].reduce(
      (sum, pos) => sum + pos.pnl,
      0
    ) + hip3TotalPnl

    // Cleanup
    await registry.cleanup()

    const response: ArbPositionsSuccessResponse = {
      status: 'success',
      positions: positionsByProtocol,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
    }

    return c.json(response)
  } catch (error) {
    log.error('[arb/positions] Error:', error instanceof Error ? error.message : error)

    if (registry) {
      try {
        await registry.cleanup()
      } catch (cleanupError) {
        log.error('[arb/positions] Error cleaning up:', cleanupError)
      }
    }

    const errorResponse: ArbPositionsErrorResponse = {
      status: 'error',
      message: 'Failed to fetch positions',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    return c.json(errorResponse, 500)
  }
}
