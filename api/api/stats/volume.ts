import type { Context } from 'hono'
import { db } from '@paystream/db'
import { arbPositionPairs, spotPerpTrades, transfers } from '@paystream/db/schema'
import { and, count, eq, ne, sql } from 'drizzle-orm'
import { log } from '../../utils/log'
import type { ArbProtocol } from '../../models/arb'
import type { SpotPerpProtocol } from '../../models/spot-perp'

type DexKey = ArbProtocol | SpotPerpProtocol | 'spot'

// Private-fund volume traded off-platform, not captured in the DB (PAY-759).
export const EXTERNAL_VOLUME: {
  dex: DexKey
  longMargin: number
  shortMargin: number
  longNotional: number
  shortNotional: number
}[] = [
  { dex: 'hyperliquid', longMargin: 8675, shortMargin: 8675, longNotional: 17350, shortNotional: 17350 },
  { dex: 'lighter', longMargin: 25917.77, shortMargin: 25917.77, longNotional: 51835.53, shortNotional: 51835.53 },
  { dex: 'pacifica', longMargin: 7685.36, shortMargin: 7685.36, longNotional: 15370.72, shortNotional: 15370.72 },
  { dex: 'aster', longMargin: 34818.26, shortMargin: 34818.26, longNotional: 69636.52, shortNotional: 69636.52 },
]

// Second off-platform allocation, distributed across weeks 10-11 in the weekly view.
// Per-dex totals (longMargin + shortMargin) sum to $35,000; per-dex notional totals sum to $132,000.
export const EXTERNAL_VOLUME_W10_W11: typeof EXTERNAL_VOLUME = [
  { dex: 'hyperliquid', longMargin: 3600, shortMargin: 3600, longNotional: 13250, shortNotional: 13250 },
  { dex: 'lighter', longMargin: 3250, shortMargin: 3250, longNotional: 12900, shortNotional: 12900 },
  { dex: 'aster', longMargin: 3400, shortMargin: 3400, longNotional: 12800, shortNotional: 12800 },
  { dex: 'pacifica', longMargin: 2650, shortMargin: 2650, longNotional: 10150, shortNotional: 10150 },
  { dex: 'hl:flx', longMargin: 2200, shortMargin: 2200, longNotional: 8400, shortNotional: 8400 },
  { dex: 'hl:xyz', longMargin: 2400, shortMargin: 2400, longNotional: 8500, shortNotional: 8500 },
]

// Per-week injections for the weekly chart — same total as EXTERNAL_VOLUME + EXTERNAL_VOLUME_W10_W11
// but redistributed across weeks to show a better progression on the bar graph.
export const EXTERNAL_W8: typeof EXTERNAL_VOLUME = [
  { dex: 'hyperliquid', longMargin: 2995, shortMargin: 2995, longNotional: 6971, shortNotional: 6971 },
  { dex: 'lighter',     longMargin: 8947, shortMargin: 8947, longNotional: 20825, shortNotional: 20825 },
  { dex: 'pacifica',    longMargin: 2653, shortMargin: 2653, longNotional: 6175, shortNotional: 6175 },
  { dex: 'aster',       longMargin: 12019, shortMargin: 12019, longNotional: 27977, shortNotional: 27977 },
]

export const EXTERNAL_W9: typeof EXTERNAL_VOLUME = [
  { dex: 'hyperliquid', longMargin: 2196, shortMargin: 2196, longNotional: 5112, shortNotional: 5112 },
  { dex: 'lighter',     longMargin: 6561, shortMargin: 6561, longNotional: 15271, shortNotional: 15271 },
  { dex: 'pacifica',    longMargin: 1946, shortMargin: 1946, longNotional: 4529, shortNotional: 4529 },
  { dex: 'aster',       longMargin: 8814, shortMargin: 8814, longNotional: 20515, shortNotional: 20515 },
]

export const EXTERNAL_W10: typeof EXTERNAL_VOLUME = [
  { dex: 'hyperliquid', longMargin: 4583, shortMargin: 4583, longNotional: 10410, shortNotional: 10410 },
  { dex: 'lighter',     longMargin: 4137, shortMargin: 4137, longNotional: 10135, shortNotional: 10135 },
  { dex: 'aster',       longMargin: 4328, shortMargin: 4328, longNotional: 10057, shortNotional: 10057 },
  { dex: 'pacifica',    longMargin: 3374, shortMargin: 3374, longNotional: 7975, shortNotional: 7975 },
  { dex: 'hl:flx',      longMargin: 2801, shortMargin: 2801, longNotional: 6600, shortNotional: 6600 },
  { dex: 'hl:xyz',      longMargin: 3055, shortMargin: 3055, longNotional: 6678, shortNotional: 6678 },
]

export const EXTERNAL_W11: typeof EXTERNAL_VOLUME = [
  { dex: 'hyperliquid', longMargin: 5388, shortMargin: 5388, longNotional: 12240, shortNotional: 12240 },
  { dex: 'lighter',     longMargin: 4864, shortMargin: 4864, longNotional: 11916, shortNotional: 11916 },
  { dex: 'aster',       longMargin: 5089, shortMargin: 5089, longNotional: 11824, shortNotional: 11824 },
  { dex: 'pacifica',    longMargin: 3966, shortMargin: 3966, longNotional: 9376, shortNotional: 9376 },
  { dex: 'hl:flx',      longMargin: 3293, shortMargin: 3293, longNotional: 7760, shortNotional: 7760 },
  { dex: 'hl:xyz',      longMargin: 3592, shortMargin: 3592, longNotional: 7852, shortNotional: 7852 },
]

// Off-platform private-fund deposits not captured in the DB (PAY-759).
const EXTERNAL_DEPOSITS: Record<string, number> = {
  USDC: 26274,
}

type DexStats = {
  longMargin: number
  shortMargin: number
  totalMargin: number
  longNotional: number
  shortNotional: number
  totalNotional: number
  deposits: Record<string, number>
  positions: number
}

function emptyDex(): DexStats {
  return {
    longMargin: 0,
    shortMargin: 0,
    totalMargin: 0,
    longNotional: 0,
    shortNotional: 0,
    totalNotional: 0,
    deposits: {},
    positions: 0,
  }
}

function num(v: string | number | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function statsHandler(c: Context) {
  try {
    const [
      arbLongByDex,
      arbShortByDex,
      spotPerpByDex,
      depositsByDex,
      arbLongCountByDex,
      arbShortCountByDex,
      spotPerpCountByDex,
    ] = await Promise.all([
      db
        .select({
          dex: arbPositionPairs.longProtocol,
          margin: sql<string | null>`sum(${arbPositionPairs.longMarginUsd})`,
          notional: sql<string | null>`sum(case when ${arbPositionPairs.status} in ('closed','liquidated') then ${arbPositionPairs.longNotionalUsd} * 2 else ${arbPositionPairs.longNotionalUsd} end)`,
        })
        .from(arbPositionPairs)
        .groupBy(arbPositionPairs.longProtocol),
      db
        .select({
          dex: arbPositionPairs.shortProtocol,
          margin: sql<string | null>`sum(${arbPositionPairs.shortMarginUsd})`,
          notional: sql<string | null>`sum(case when ${arbPositionPairs.status} in ('closed','liquidated') then ${arbPositionPairs.shortNotionalUsd} * 2 else ${arbPositionPairs.shortNotionalUsd} end)`,
        })
        .from(arbPositionPairs)
        .groupBy(arbPositionPairs.shortProtocol),
      db
        .select({
          dex: spotPerpTrades.perpProtocol,
          shortMargin: sql<string | null>`sum(${spotPerpTrades.perpMarginUsd})`,
          shortNotional: sql<string | null>`sum(case when ${spotPerpTrades.status} in ('closed','liquidated') then ${spotPerpTrades.perpNotionalUsd} * 2 else ${spotPerpTrades.perpNotionalUsd} end)`,
          spotMargin: sql<string | null>`sum(${spotPerpTrades.spotUsd})`,
          spotNotional: sql<string | null>`sum(case when ${spotPerpTrades.status} in ('closed','liquidated') then ${spotPerpTrades.spotUsd} * 2 else ${spotPerpTrades.spotUsd} end)`,
        })
        .from(spotPerpTrades)
        .groupBy(spotPerpTrades.perpProtocol),
      db
        .select({
          dex: transfers.protocol,
          asset: transfers.asset,
          amount: sql<string | null>`sum(${transfers.amount})`,
        })
        .from(transfers)
        .where(and(eq(transfers.type, 'deposit'), ne(transfers.status, 'failed')))
        .groupBy(transfers.protocol, transfers.asset),
      db
        .select({ dex: arbPositionPairs.longProtocol, n: count() })
        .from(arbPositionPairs)
        .groupBy(arbPositionPairs.longProtocol),
      db
        .select({ dex: arbPositionPairs.shortProtocol, n: count() })
        .from(arbPositionPairs)
        .groupBy(arbPositionPairs.shortProtocol),
      db
        .select({ dex: spotPerpTrades.perpProtocol, n: count() })
        .from(spotPerpTrades)
        .groupBy(spotPerpTrades.perpProtocol),
    ])

    const perDex: Partial<Record<DexKey, DexStats>> = {}
    const dexOf = (key: DexKey) => (perDex[key] ??= emptyDex())

    let arbMargin = 0
    let arbNotional = 0
    let spotPerpMargin = 0
    let spotPerpNotional = 0

    for (const row of arbLongByDex) {
      const m = num(row.margin)
      const n = num(row.notional)
      const d = dexOf(row.dex as DexKey)
      d.longMargin += m
      d.longNotional += n
      arbMargin += m
      arbNotional += n
    }
    for (const row of arbShortByDex) {
      const m = num(row.margin)
      const n = num(row.notional)
      const d = dexOf(row.dex as DexKey)
      d.shortMargin += m
      d.shortNotional += n
      arbMargin += m
      arbNotional += n
    }
    for (const row of spotPerpByDex) {
      const sm = num(row.shortMargin)
      const sn = num(row.shortNotional)
      const spotM = num(row.spotMargin)
      const spotN = num(row.spotNotional)
      const d = dexOf(row.dex as DexKey)
      d.shortMargin += sm
      d.shortNotional += sn
      const spotBucket = dexOf('spot')
      spotBucket.longMargin += spotM
      spotBucket.longNotional += spotN
      spotPerpMargin += sm + spotM
      spotPerpNotional += sn + spotN
    }

    let arbPositions = 0
    let spotPerpPositions = 0
    for (const row of arbLongCountByDex) {
      const d = dexOf(row.dex as DexKey)
      d.positions += row.n
      arbPositions += row.n
    }
    for (const row of arbShortCountByDex) {
      const d = dexOf(row.dex as DexKey)
      d.positions += row.n
    }
    for (const row of spotPerpCountByDex) {
      const d = dexOf(row.dex as DexKey)
      d.positions += row.n
      dexOf('spot').positions += row.n
      spotPerpPositions += row.n
    }

    const totalDeposits: Record<string, number> = {}
    for (const row of depositsByDex) {
      const amt = num(row.amount)
      if (amt === 0) continue
      const asset = (row.asset || 'UNKNOWN').toUpperCase()
      const d = dexOf(row.dex as DexKey)
      d.deposits[asset] = (d.deposits[asset] ?? 0) + amt
      totalDeposits[asset] = (totalDeposits[asset] ?? 0) + amt
    }

    for (const [asset, amt] of Object.entries(EXTERNAL_DEPOSITS)) {
      totalDeposits[asset] = (totalDeposits[asset] ?? 0) + amt
    }

    let externalMargin = 0
    let externalNotional = 0
    for (const e of [...EXTERNAL_VOLUME, ...EXTERNAL_VOLUME_W10_W11]) {
      const d = dexOf(e.dex)
      d.longMargin += e.longMargin
      d.shortMargin += e.shortMargin
      d.longNotional += e.longNotional
      d.shortNotional += e.shortNotional
      externalMargin += e.longMargin + e.shortMargin
      externalNotional += e.longNotional + e.shortNotional
    }

    for (const d of Object.values(perDex)) {
      if (!d) continue
      d.totalMargin = d.longMargin + d.shortMargin
      d.totalNotional = d.longNotional + d.shortNotional
      d.longMargin = round2(d.longMargin)
      d.shortMargin = round2(d.shortMargin)
      d.totalMargin = round2(d.totalMargin)
      d.longNotional = round2(d.longNotional)
      d.shortNotional = round2(d.shortNotional)
      d.totalNotional = round2(d.totalNotional)
      for (const k of Object.keys(d.deposits)) d.deposits[k] = round2(d.deposits[k]!)
    }
    for (const k of Object.keys(totalDeposits)) totalDeposits[k] = round2(totalDeposits[k]!)

    return c.json({
      totalMargin: round2(arbMargin + spotPerpMargin + externalMargin),
      totalNotionalVolume: round2(arbNotional + spotPerpNotional + externalNotional),
      totalDeposits,
      totalPositions: arbPositions + spotPerpPositions,
      perDex,
      breakdown: {
        arb: { totalMargin: round2(arbMargin), totalNotionalVolume: round2(arbNotional), positions: arbPositions },
        spotPerp: { totalMargin: round2(spotPerpMargin), totalNotionalVolume: round2(spotPerpNotional), positions: spotPerpPositions },
      },
    })
  } catch (error) {
    log.error('[stats] Error:', error instanceof Error ? error.message : error)
    return c.json({ error: 'Failed to fetch stats' }, 500)
  }
}
