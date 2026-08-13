import { db } from '@paystream/db'
import { arbPositionPairs, spotPerpTrades, fundingRateHistory, telegramUserLinks } from '@paystream/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { log } from '../../utils/log.js'

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:9090'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

export interface PortfolioSummary {
  arbPositions: {
    count: number
    totalMarginUsd: number
    positions: Array<{
      id: number
      symbol: string
      longProtocol: string
      shortProtocol: string
      totalMarginUsd: number
      status: string
      realizedPnl: number | null
    }>
  }
  spotPerpTrades: {
    count: number
    totalUsd: number
    positions: Array<{
      id: number
      market: string
      perpProtocol: string
      totalUsd: number
      status: string
    }>
  }
}

export async function getPortfolio(privyUserId: string): Promise<PortfolioSummary> {
  const [arbPositions, spotPerps] = await Promise.all([
    db
      .select()
      .from(arbPositionPairs)
      .where(and(eq(arbPositionPairs.privyUserId, privyUserId), eq(arbPositionPairs.active, true)))
      .orderBy(desc(arbPositionPairs.createdAt)),
    db
      .select()
      .from(spotPerpTrades)
      .where(and(eq(spotPerpTrades.privyUserId, privyUserId), eq(spotPerpTrades.active, true)))
      .orderBy(desc(spotPerpTrades.createdAt)),
  ])

  return {
    arbPositions: {
      count: arbPositions.length,
      totalMarginUsd: arbPositions.reduce((sum, p) => sum + p.totalMarginUsd, 0),
      positions: arbPositions.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        longProtocol: p.longProtocol,
        shortProtocol: p.shortProtocol,
        totalMarginUsd: p.totalMarginUsd,
        status: p.status,
        realizedPnl: p.realizedPnl,
      })),
    },
    spotPerpTrades: {
      count: spotPerps.length,
      totalUsd: spotPerps.reduce((sum, p) => sum + p.totalUsd, 0),
      positions: spotPerps.map((p) => ({
        id: p.id,
        market: p.market,
        perpProtocol: p.perpProtocol,
        totalUsd: p.totalUsd,
        status: p.status,
      })),
    },
  }
}

export interface DetailedPosition {
  id: number
  symbol: string
  longProtocol: string
  shortProtocol: string
  longEntryPrice: number | null
  shortEntryPrice: number | null
  longLiquidationPrice: number | null
  shortLiquidationPrice: number | null
  longLeverage: number
  shortLeverage: number
  longMarginUsd: number
  shortMarginUsd: number
  totalMarginUsd: number
  lastOraclePrice: number | null
  sizeAsset: number | null
  status: string
  createdAt: Date
}

export async function getDetailedPositions(privyUserId: string): Promise<DetailedPosition[]> {
  const positions = await db
    .select()
    .from(arbPositionPairs)
    .where(and(eq(arbPositionPairs.privyUserId, privyUserId), eq(arbPositionPairs.active, true)))
    .orderBy(desc(arbPositionPairs.createdAt))

  return positions.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    longProtocol: p.longProtocol,
    shortProtocol: p.shortProtocol,
    longEntryPrice: p.longEntryPrice,
    shortEntryPrice: p.shortEntryPrice,
    longLiquidationPrice: p.longLiquidationPrice,
    shortLiquidationPrice: p.shortLiquidationPrice,
    longLeverage: p.longLeverage,
    shortLeverage: p.shortLeverage,
    longMarginUsd: p.longMarginUsd,
    shortMarginUsd: p.shortMarginUsd,
    totalMarginUsd: p.totalMarginUsd,
    lastOraclePrice: p.lastOraclePrice,
    sizeAsset: p.sizeAsset,
    status: p.status,
    createdAt: p.createdAt,
  }))
}

export interface LivePositionInfo {
  symbol: string
  direction: string
  sizeUsd: number
  sizeAsset: number
  pnl: number
  unrealizedPnl: number
  fundingIncome: number
  entryPrice: number
  leverage: number
  margin: number
  liquidationPrice?: number
}

export interface LivePositionsByProtocol {
  pacifica: LivePositionInfo[]
  hyperliquid: LivePositionInfo[]
  aster: LivePositionInfo[]
  lighter: LivePositionInfo[]
}

/**
 * Fetch live positions from all DEXes via the backend internal API.
 * Returns null on failure (caller should fall back to DB data).
 */
export async function fetchLivePositions(
  privyUserId: string,
  walletAddress: string,
  ethAddress: string | null,
): Promise<LivePositionsByProtocol | null> {
  try {
    // If eth_address is missing from the link, try to get it from existing positions
    let resolvedEthAddress = ethAddress
    if (!resolvedEthAddress) {
      const [posWithEth] = await db
        .select({ ethAddress: arbPositionPairs.ethAddress })
        .from(arbPositionPairs)
        .where(eq(arbPositionPairs.privyUserId, privyUserId))
        .limit(1)

      if (posWithEth?.ethAddress) {
        resolvedEthAddress = posWithEth.ethAddress
        // Backfill the link so we don't look it up every time
        await db
          .update(telegramUserLinks)
          .set({ ethAddress: resolvedEthAddress })
          .where(eq(telegramUserLinks.privyUserId, privyUserId))
          .catch(() => {})
      }
    }

    const res = await fetch(`${BACKEND_URL}/api/internal/arb/positions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({ privyUserId, walletAddress, ethAddress: resolvedEthAddress }),
    })

    if (!res.ok) {
      log.warn(`[portfolio] Live positions fetch failed: HTTP ${res.status}`)
      return null
    }

    const data = await res.json()
    if (data.status !== 'success') {
      log.warn(`[portfolio] Live positions fetch error: ${data.message}`)
      return null
    }

    return data.positions as LivePositionsByProtocol
  } catch (error) {
    log.warn('[portfolio] Live positions fetch failed:', error)
    return null
  }
}

export async function getFundingRates(symbol?: string): Promise<
  Array<{
    dex: string
    symbol: string
    rate: number
    timestamp: Date
  }>
> {
  const conditions = symbol
    ? eq(fundingRateHistory.symbol, symbol.toUpperCase())
    : undefined

  const rates = await db
    .select()
    .from(fundingRateHistory)
    .where(conditions)
    .orderBy(desc(fundingRateHistory.timestamp))
    .limit(50)

  // Deduplicate by dex+symbol (equivalent to Prisma distinct)
  const seen = new Set<string>()
  const deduplicated: typeof rates = []
  for (const r of rates) {
    const key = `${r.dex}:${r.symbol}`
    if (!seen.has(key)) {
      seen.add(key)
      deduplicated.push(r)
    }
  }

  return deduplicated.map((r) => ({
    dex: r.dex,
    symbol: r.symbol,
    rate: r.rate,
    timestamp: r.timestamp,
  }))
}
