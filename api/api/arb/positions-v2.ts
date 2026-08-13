import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import type {
  ArbPositionsV2SuccessResponse,
  ArbPositionsErrorResponse,
  ArbPositionInfo,
  ArbLivePositionPair,
  ArbLiveData,
  ArbProtocol,
} from '../../models/arb'
import { getInitializedProviders } from '@paystream/perps/registry'
import { getHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import { getStoredApiCredentialsAsync } from '../../clients/arb/aster-auth'
import { applyLighterReadCredentials } from '../../clients/arb/lighter-auth'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../utils/wallet'
import { log } from '../../utils/log'
import { db } from '@paystream/db'
import { arbPositionPairs } from '@paystream/db/schema'
import { and, eq } from 'drizzle-orm'

/**
 * GET /api/arb/positions/v2
 * Pair-centric positions: live on-chain data matched against
 * arb_position_pairs for risk tags and entry data.
 */
export async function positionsV2Handler(c: Context) {
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

    const activePairs = await db.select({
      publicId: arbPositionPairs.publicId,
      symbol: arbPositionPairs.symbol,
      longSymbol: arbPositionPairs.longSymbol,
      shortSymbol: arbPositionPairs.shortSymbol,
      status: arbPositionPairs.status,
      riskTag: arbPositionPairs.riskTag,
      riskParams: arbPositionPairs.riskParams,
      negFundingCount: arbPositionPairs.negFundingCount,
      entryApy: arbPositionPairs.entryApy,
      totalMarginUsd: arbPositionPairs.totalMarginUsd,
      lastOraclePrice: arbPositionPairs.lastOraclePrice,
      longProtocol: arbPositionPairs.longProtocol,
      longMarginUsd: arbPositionPairs.longMarginUsd,
      longNotionalUsd: arbPositionPairs.longNotionalUsd,
      longLeverage: arbPositionPairs.longLeverage,
      longEntryPrice: arbPositionPairs.longEntryPrice,
      longTxSignature: arbPositionPairs.longTxSignature,
      shortProtocol: arbPositionPairs.shortProtocol,
      shortMarginUsd: arbPositionPairs.shortMarginUsd,
      shortNotionalUsd: arbPositionPairs.shortNotionalUsd,
      shortLeverage: arbPositionPairs.shortLeverage,
      shortEntryPrice: arbPositionPairs.shortEntryPrice,
      shortTxSignature: arbPositionPairs.shortTxSignature,
      createdAt: arbPositionPairs.createdAt,
      disableAclp: arbPositionPairs.disableAclp,
      survivingLegSlSet: arbPositionPairs.survivingLegSlSet,
      disableAutoclose: arbPositionPairs.disableAutoclose,
    })
      .from(arbPositionPairs)
      .where(and(
        eq(arbPositionPairs.privyUserId, authData.user.id),
        eq(arbPositionPairs.active, true),
      ))

    if (activePairs.length === 0) {
      const response: ArbPositionsV2SuccessResponse = {
        status: 'success',
        pairs: [],
        unmatched: {},
        totalPnl: 0,
      }
      return c.json(response)
    }

    const neededProtocols = [...new Set(activePairs.flatMap(pair => [
      pair.longProtocol,
      pair.shortProtocol,
    ] as ArbProtocol[]))]

    const walletPubkey = new PublicKey(embeddedWallet.address)
    registry = await getInitializedProviders(walletPubkey, embeddedEthWallet?.address, neededProtocols)

    const asterProvider = registry.getAsterProvider()
    const lighterProvider = registry.getLighterProvider()
    const pacificaProvider = registry.getProvider('pacifica')
    const hyperliquidProvider = registry.getProvider('hyperliquid')
    const zoProvider = registry.getZoProvider()
    const phoenixProvider = registry.getPhoenixProvider()

    if (asterProvider) {
      const creds = await getStoredApiCredentialsAsync(authData.user.id)
      if (creds) {
        asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)
      }
    }

    if (lighterProvider && embeddedEthWallet) {
      await applyLighterReadCredentials(lighterProvider, authData.user.id, embeddedEthWallet.address)
    }

    // Fetch live positions only for protocols already tracked in DB. Trigger
    // prices are fetched separately on-demand to keep this hot path lighter.
    const [asterPositions, lighterPositions, pacificaPositions, hyperliquidPositions, zoPositions, phoenixPositions] = await Promise.all([
      asterProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }) || [],
      lighterProvider && embeddedEthWallet
        ? lighterProvider.getPositionsByEthAddress(embeddedEthWallet.address, { includeTriggerPrices: false })
        : [],
      pacificaProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }) || [],
      hyperliquidProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }) || [],
      zoProvider?.getPositions(walletPubkey, { includeTriggerPrices: false }) || [],
      phoenixProvider?.getPositions(walletPubkey) || [],
    ])

    // Fetch HIP-3 positions per curated dex (shares HL ETH wallet)
    const hip3Providers = registry.getHip3Providers()
    const hip3Entries = Array.from(hip3Providers.entries())
    const hip3Results = embeddedEthWallet
      ? await Promise.all(hip3Entries.map(async ([dexName, provider]) => {
          try {
            return { dexName, positions: await provider.getPositions(walletPubkey, { includeTriggerPrices: false }) }
          } catch (err) {
            log.error(`[arb/positions/v2] Failed to fetch HIP-3 ${dexName} positions:`, err instanceof Error ? err.message : err)
            return { dexName, positions: [] as typeof asterPositions }
          }
        }))
      : []

    const positionsByKey = new Map<string, typeof asterPositions[number]>()
    const addToMap = (positions: typeof asterPositions, protocol: string) => {
      for (const pos of positions) {
        positionsByKey.set(`${protocol}:${pos.symbol.toUpperCase()}:${pos.direction}`, pos)
      }
    }
    addToMap(asterPositions, 'aster')
    addToMap(lighterPositions, 'lighter')
    addToMap(pacificaPositions, 'pacifica')
    addToMap(hyperliquidPositions, 'hyperliquid')
    addToMap(zoPositions, '01')
    addToMap(phoenixPositions, 'phoenix')
    for (const { dexName, positions } of hip3Results) {
      addToMap(positions, getHip3ProtocolId(dexName))
    }

    const matchedKeys = new Set<string>()

    const toLiveData = (pos: typeof asterPositions[number]): ArbLiveData => ({
      size: { usd: pos.sizeUsd, asset: pos.sizeAsset },
      pnl: pos.pnl,
      unrealizedPnl: pos.unrealizedPnl,
      fundingIncome: pos.fundingIncome,
      entryPrice: pos.entryPrice,
      leverage: pos.leverage,
      margin: pos.margin,
      liquidationPrice: pos.liquidationPrice ?? null,
    })

    const pairs: ArbLivePositionPair[] = activePairs.map(pair => {
      // Cross-ticker pairs carry per-leg symbols; legacy single-ticker pairs
      // only populate the shared `symbol` column.
      const longSymbol = pair.longSymbol ?? pair.symbol
      const shortSymbol = pair.shortSymbol ?? pair.symbol
      const longKey = `${pair.longProtocol}:${longSymbol.toUpperCase()}:long`
      const shortKey = `${pair.shortProtocol}:${shortSymbol.toUpperCase()}:short`

      const longLive = positionsByKey.get(longKey)
      const shortLive = positionsByKey.get(shortKey)

      if (longLive) matchedKeys.add(longKey)
      if (shortLive) matchedKeys.add(shortKey)

      return {
        publicId: pair.publicId,
        symbol: pair.symbol,
        status: pair.status,
        riskTag: pair.riskTag,
        riskParams: pair.riskParams,
        negFundingCount: pair.negFundingCount,
        entryApy: pair.entryApy,
        totalMarginUsd: pair.totalMarginUsd,
        lastOraclePrice: pair.lastOraclePrice,
        long: {
          protocol: pair.longProtocol as ArbProtocol,
          symbol: longSymbol,
          marginUsd: pair.longMarginUsd,
          notionalUsd: pair.longNotionalUsd,
          leverage: pair.longLeverage,
          entryPrice: pair.longEntryPrice,
          txSignature: pair.longTxSignature,
          live: longLive ? toLiveData(longLive) : null,
        },
        short: {
          protocol: pair.shortProtocol as ArbProtocol,
          symbol: shortSymbol,
          marginUsd: pair.shortMarginUsd,
          notionalUsd: pair.shortNotionalUsd,
          leverage: pair.shortLeverage,
          entryPrice: pair.shortEntryPrice,
          txSignature: pair.shortTxSignature,
          live: shortLive ? toLiveData(shortLive) : null,
        },
        createdAt: pair.createdAt.toISOString(),
        disableAclp: pair.disableAclp,
        survivingLegSlSet: pair.survivingLegSlSet,
        disableAutoclose: pair.disableAutoclose,
      }
    })

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
    })

    const filterUnmatched = (positions: typeof asterPositions, protocol: string) =>
      positions
        .filter(p => !matchedKeys.has(`${protocol}:${p.symbol.toUpperCase()}:${p.direction}`))
        .map(toPositionInfo)

    const hip3AllPositions = hip3Results.flatMap(r => r.positions)
    const totalPnl = [...asterPositions, ...lighterPositions, ...pacificaPositions, ...hyperliquidPositions, ...zoPositions, ...phoenixPositions, ...hip3AllPositions]
      .reduce((sum, pos) => sum + pos.pnl, 0)

    await registry.cleanup()

    const unmatched: ArbPositionsV2SuccessResponse['unmatched'] = {
      aster: filterUnmatched(asterPositions, 'aster'),
      lighter: filterUnmatched(lighterPositions, 'lighter'),
      pacifica: filterUnmatched(pacificaPositions, 'pacifica'),
      hyperliquid: filterUnmatched(hyperliquidPositions, 'hyperliquid'),
      '01': filterUnmatched(zoPositions, '01'),
      phoenix: filterUnmatched(phoenixPositions, 'phoenix'),
    }
    for (const { dexName, positions } of hip3Results) {
      const protocolId = getHip3ProtocolId(dexName)
      unmatched[protocolId] = filterUnmatched(positions, protocolId)
    }

    const response: ArbPositionsV2SuccessResponse = {
      status: 'success',
      pairs,
      unmatched,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
    }

    return c.json(response)
  } catch (error) {
    log.error('[arb/positions/v2] Error:', error instanceof Error ? error.message : error)

    if (registry) {
      try {
        await registry.cleanup()
      } catch (cleanupError) {
        log.error('[arb/positions/v2] Error cleaning up:', cleanupError)
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
