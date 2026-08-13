import type { Context } from 'hono'
import { db } from '@paystream/db'
import { fundingRateHistory } from '@paystream/db/schema'
import { and, asc, desc, eq, gte } from 'drizzle-orm'
import { daysAgo } from '@paystream/perps/funding-rates/utils'
import { HIP3_DEX_NAMES, getHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import { ARB_BASE_PROTOCOLS, type ArbProtocol } from '../../../models/arb'
import { log } from '../../../utils/log'

const MAX_DAYS = 30

const ALL_DEXES: ArbProtocol[] = [
  ...ARB_BASE_PROTOCOLS,
  ...HIP3_DEX_NAMES.map(getHip3ProtocolId),
]

interface RateEntry {
  timestamp: number
  fundingRate: number
  granularity: string
}

type SymbolData = Record<ArbProtocol, RateEntry[] | null>

const EMPTY_SYMBOL_DATA = Object.fromEntries(
  ALL_DEXES.map(d => [d, null]),
) as SymbolData

export async function fundingRatesHistoryHandler(c: Context) {
  try {
    const symbol = c.req.query('symbol')?.toUpperCase()

    const daysRaw = c.req.query('days')
    let days = MAX_DAYS
    if (daysRaw !== undefined) {
      const parsed = parseInt(daysRaw, 10)
      if (isNaN(parsed) || parsed < 1) {
        return c.json({ error: 'days must be a positive integer' }, 400)
      }
      days = Math.min(parsed, MAX_DAYS)
    }

    const orderBy = c.req.query('order') === 'asc'
      ? asc(fundingRateHistory.timestamp)
      : desc(fundingRateHistory.timestamp)

    const conditions = [gte(fundingRateHistory.timestamp, daysAgo(days))]
    if (symbol) conditions.push(eq(fundingRateHistory.symbol, symbol))

    const rows = await db.select({
      symbol: fundingRateHistory.symbol,
      dex: fundingRateHistory.dex,
      timestamp: fundingRateHistory.timestamp,
      rate: fundingRateHistory.rate,
      granularity: fundingRateHistory.granularity,
    }).from(fundingRateHistory)
      .where(and(...conditions))
      .orderBy(orderBy)

    // Group: symbol → dex → entries[]
    const result: Record<string, SymbolData> = {}

    for (const row of rows) {
      if (!result[row.symbol]) {
        result[row.symbol] = { ...EMPTY_SYMBOL_DATA }
      }

      const dex = row.dex as ArbProtocol
      if (!result[row.symbol][dex]) {
        result[row.symbol][dex] = []
      }

      ;(result[row.symbol][dex] as RateEntry[]).push({
        timestamp: row.timestamp.getTime(),
        fundingRate: row.rate,
        granularity: row.granularity,
      })
    }

    return c.json(result)
  } catch (error) {
    log.error('[funding-rates-history] Error:', error instanceof Error ? error.message : error)
    return c.json({
      error: 'Failed to fetch funding rate history',
    }, 500)
  }
}
