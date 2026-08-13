import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import { getInitializedProviders } from '@paystream/perps/registry'
import { getHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import { getStoredApiCredentialsAsync } from '../../clients/arb/aster-auth'
import { log } from '../../utils/log'

/**
 * POST /api/internal/arb/positions
 * Internal endpoint for fetching live arb positions by privyUserId.
 * Authenticated via x-service-key header.
 * Body: { privyUserId: string, walletAddress: string, ethAddress?: string }
 */
export async function internalArbPositionsHandler(c: Context) {
  let registry = null

  try {
    const { privyUserId, walletAddress, ethAddress } = await c.req.json()

    if (!privyUserId || !walletAddress) {
      return c.json({ status: 'error', message: 'Missing required fields: privyUserId, walletAddress' }, 400)
    }

    const walletPubkey = new PublicKey(walletAddress)
    registry = await getInitializedProviders(walletPubkey, ethAddress)

    const asterProvider = registry.getAsterProvider()
    const lighterProvider = registry.getLighterProvider()
    const pacificaProvider = registry.getProvider('pacifica')
    const hyperliquidProvider = registry.getProvider('hyperliquid')

    if (asterProvider) {
      const creds = await getStoredApiCredentialsAsync(privyUserId)
      if (creds) {
        asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)
      }
    }

    const [asterPositions, lighterPositions, pacificaPositions, hyperliquidPositions] = await Promise.all([
      asterProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }) || [],
      lighterProvider && ethAddress
        ? lighterProvider.getPositionsByEthAddress(ethAddress, { includeTriggerPrices: false })
        : [],
      pacificaProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }) || [],
      hyperliquidProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }) || [],
    ])

    // Fetch HIP-3 positions from each curated dex (requires ETH wallet)
    const hip3Providers = registry.getHip3Providers()
    const hip3Entries = Array.from(hip3Providers.entries())
    const hip3Results = ethAddress
      ? await Promise.all(hip3Entries.map(async ([dexName, provider]) => {
          try {
            return { dexName, positions: await provider.getPositions(walletPubkey, { includeTriggerPrices: false }) }
          } catch (err) {
            log.error(`[internal/arb-positions] Failed to fetch HIP-3 ${dexName}:`, err instanceof Error ? err.message : err)
            return { dexName, positions: [] }
          }
        }))
      : []

    const toInfo = (pos: any) => ({
      symbol: pos.symbol,
      direction: pos.direction,
      sizeUsd: pos.sizeUsd,
      sizeAsset: pos.sizeAsset,
      pnl: pos.pnl,
      unrealizedPnl: pos.unrealizedPnl,
      fundingIncome: pos.fundingIncome,
      entryPrice: pos.entryPrice,
      leverage: pos.leverage,
      margin: pos.margin,
      liquidationPrice: pos.liquidationPrice,
    })

    await registry.cleanup()

    const positions: Record<string, any[]> = {
      pacifica: pacificaPositions.map(toInfo),
      hyperliquid: hyperliquidPositions.map(toInfo),
      aster: asterPositions.map(toInfo),
      lighter: lighterPositions.map(toInfo),
    }
    for (const { dexName, positions: hip3Positions } of hip3Results) {
      positions[getHip3ProtocolId(dexName as any)] = hip3Positions.map(toInfo)
    }

    return c.json({
      status: 'success',
      positions,
    })
  } catch (error) {
    log.error('[internal/arb-positions] Error:', error)

    if (registry) {
      try { await registry.cleanup() } catch {}
    }

    return c.json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
