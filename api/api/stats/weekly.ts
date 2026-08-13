import type { Context } from 'hono'
import { db } from '@paystream/db'
import { arbPositionPairs, spotPerpTrades } from '@paystream/db/schema'
import { count, sql } from 'drizzle-orm'
import { log } from '../../utils/log'
import type { ArbProtocol } from '../../models/arb'
import type { SpotPerpProtocol } from '../../models/spot-perp'
import { EXTERNAL_W8, EXTERNAL_W9, EXTERNAL_W10, EXTERNAL_W11 } from './volume'

type DexKey = ArbProtocol | SpotPerpProtocol | 'spot'

// Off-platform (PAY-759) volume injected into specific weeks (one entry per week).
// weekIndexes are 0-based indexes into the sorted DB week buckets.
const EXTERNAL_INJECTIONS: {
  weekIndexes: readonly number[]
  positionsPerDexPerWeek: number
  entries: typeof EXTERNAL_W8
}[] = [
  { weekIndexes: [7], positionsPerDexPerWeek: 3, entries: EXTERNAL_W8 },  // week 8
  { weekIndexes: [8], positionsPerDexPerWeek: 3, entries: EXTERNAL_W9 },  // week 9
  { weekIndexes: [9], positionsPerDexPerWeek: 3, entries: EXTERNAL_W10 }, // week 10
  { weekIndexes: [10], positionsPerDexPerWeek: 4, entries: EXTERNAL_W11 }, // week 11
]

type DexStats = {
  longMargin: number
  shortMargin: number
  totalMargin: number
  longNotional: number
  shortNotional: number
  totalNotional: number
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

// date_trunc('week', ...) — Postgres week starts on Monday (ISO 8601), UTC
const weekStartArb = sql<Date>`date_trunc('week', ${arbPositionPairs.createdAt})`
const weekStartSpotPerp = sql<Date>`date_trunc('week', ${spotPerpTrades.createdAt})`

function weekBounds(start: Date): { startKey: string; start: string; end: string } {
  const startDate = new Date(start)
  const endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000)
  return { startKey: startDate.toISOString(), start: startDate.toISOString(), end: endDate.toISOString() }
}

type WeekBucket = {
  start: string
  end: string
  perDex: Partial<Record<DexKey, DexStats>>
}

export async function weeklyStatsHandler(c: Context) {
  try {
    const [
      arbLongRows,
      arbShortRows,
      spotPerpRows,
      arbLongCountRows,
      arbShortCountRows,
      spotPerpCountRows,
    ] = await Promise.all([
      db
        .select({
          week: weekStartArb,
          dex: arbPositionPairs.longProtocol,
          margin: sql<string | null>`sum(${arbPositionPairs.longMarginUsd})`,
          notional: sql<string | null>`sum(case when ${arbPositionPairs.status} in ('closed','liquidated') then ${arbPositionPairs.longNotionalUsd} * 2 else ${arbPositionPairs.longNotionalUsd} end)`,
        })
        .from(arbPositionPairs)
        .groupBy(weekStartArb, arbPositionPairs.longProtocol),
      db
        .select({
          week: weekStartArb,
          dex: arbPositionPairs.shortProtocol,
          margin: sql<string | null>`sum(${arbPositionPairs.shortMarginUsd})`,
          notional: sql<string | null>`sum(case when ${arbPositionPairs.status} in ('closed','liquidated') then ${arbPositionPairs.shortNotionalUsd} * 2 else ${arbPositionPairs.shortNotionalUsd} end)`,
        })
        .from(arbPositionPairs)
        .groupBy(weekStartArb, arbPositionPairs.shortProtocol),
      db
        .select({
          week: weekStartSpotPerp,
          dex: spotPerpTrades.perpProtocol,
          shortMargin: sql<string | null>`sum(${spotPerpTrades.perpMarginUsd})`,
          shortNotional: sql<string | null>`sum(case when ${spotPerpTrades.status} in ('closed','liquidated') then ${spotPerpTrades.perpNotionalUsd} * 2 else ${spotPerpTrades.perpNotionalUsd} end)`,
          spotMargin: sql<string | null>`sum(${spotPerpTrades.spotUsd})`,
          spotNotional: sql<string | null>`sum(case when ${spotPerpTrades.status} in ('closed','liquidated') then ${spotPerpTrades.spotUsd} * 2 else ${spotPerpTrades.spotUsd} end)`,
        })
        .from(spotPerpTrades)
        .groupBy(weekStartSpotPerp, spotPerpTrades.perpProtocol),
      db
        .select({ week: weekStartArb, dex: arbPositionPairs.longProtocol, n: count() })
        .from(arbPositionPairs)
        .groupBy(weekStartArb, arbPositionPairs.longProtocol),
      db
        .select({ week: weekStartArb, dex: arbPositionPairs.shortProtocol, n: count() })
        .from(arbPositionPairs)
        .groupBy(weekStartArb, arbPositionPairs.shortProtocol),
      db
        .select({ week: weekStartSpotPerp, dex: spotPerpTrades.perpProtocol, n: count() })
        .from(spotPerpTrades)
        .groupBy(weekStartSpotPerp, spotPerpTrades.perpProtocol),
    ])

    // Keyed internally by ISO week-start; renamed to weekN on output.
    const buckets = new Map<string, WeekBucket>()
    const bucketFor = (week: Date): WeekBucket => {
      const { startKey, start, end } = weekBounds(week)
      let b = buckets.get(startKey)
      if (!b) {
        b = { start, end, perDex: {} }
        buckets.set(startKey, b)
      }
      return b
    }
    const dexOf = (b: WeekBucket, k: DexKey) => (b.perDex[k] ??= emptyDex())

    for (const row of arbLongRows) {
      const b = bucketFor(row.week)
      const d = dexOf(b, row.dex as DexKey)
      d.longMargin += num(row.margin)
      d.longNotional += num(row.notional)
    }
    for (const row of arbShortRows) {
      const b = bucketFor(row.week)
      const d = dexOf(b, row.dex as DexKey)
      d.shortMargin += num(row.margin)
      d.shortNotional += num(row.notional)
    }
    for (const row of spotPerpRows) {
      const b = bucketFor(row.week)
      const d = dexOf(b, row.dex as DexKey)
      const sm = num(row.shortMargin)
      const sn = num(row.shortNotional)
      const spotM = num(row.spotMargin)
      const spotN = num(row.spotNotional)
      d.shortMargin += sm
      d.shortNotional += sn
      const spotBucket = dexOf(b, 'spot')
      spotBucket.longMargin += spotM
      spotBucket.longNotional += spotN
    }
    for (const row of arbLongCountRows) {
      const d = dexOf(bucketFor(row.week), row.dex as DexKey)
      d.positions += row.n
    }
    for (const row of arbShortCountRows) {
      const d = dexOf(bucketFor(row.week), row.dex as DexKey)
      d.positions += row.n
    }
    for (const row of spotPerpCountRows) {
      const b = bucketFor(row.week)
      dexOf(b, row.dex as DexKey).positions += row.n
      dexOf(b, 'spot').positions += row.n
    }
    const out: Record<string, { start: string; end: string; perDex: Partial<Record<DexKey, DexStats>> }> = {}
    const sortedKeys = Array.from(buckets.keys()).sort()
    sortedKeys.forEach((key, i) => {
      const bucket = buckets.get(key)!
      for (const inj of EXTERNAL_INJECTIONS) {
        if (!inj.weekIndexes.includes(i)) continue
        const splits = inj.weekIndexes.length
        for (const e of inj.entries) {
          const d = dexOf(bucket, e.dex)
          d.longMargin += e.longMargin / splits
          d.shortMargin += e.shortMargin / splits
          d.longNotional += e.longNotional / splits
          d.shortNotional += e.shortNotional / splits
          d.positions += inj.positionsPerDexPerWeek
        }
      }
      for (const d of Object.values(bucket.perDex)) {
        if (!d) continue
        d.totalMargin = round2(d.longMargin + d.shortMargin)
        d.totalNotional = round2(d.longNotional + d.shortNotional)
        d.longMargin = round2(d.longMargin)
        d.shortMargin = round2(d.shortMargin)
        d.longNotional = round2(d.longNotional)
        d.shortNotional = round2(d.shortNotional)
      }
      out[`week${i + 1}`] = bucket
    })

    return c.json(out)
  } catch (error) {
    log.error('[stats/weekly] Error:', error instanceof Error ? error.message : error)
    return c.json({ error: 'Failed to fetch weekly stats' }, 500)
  }
}
