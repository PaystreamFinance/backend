import type { Context } from 'hono'
import { db } from '@paystream/db'
import { fundingRateHistory } from '@paystream/db/schema'
import { and, asc, desc, eq, gte } from 'drizzle-orm'
import { daysAgo } from '@paystream/perps/funding-rates/utils'
import { isArbProtocol } from '../../../models/arb'
import { log } from '../../../utils/log'

const MAX_DAYS = 30

/** GET /api/arb/funding-rates/history/:dex — single-dex deep history (up to 30d). */
export async function fundingRatesHistoryByDexHandler(c: Context) {
  try {
    const dex = c.req.param('dex')
    if (!isArbProtocol(dex)) {
      return c.json({ error: `Unknown dex: ${dex}` }, 400)
    }

    const symbol = c.req.query('symbol')?.toUpperCase()
    if (!symbol) {
      return c.json({ error: 'symbol query param is required' }, 400)
    }

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

    const rows = await db.select({
      timestamp: fundingRateHistory.timestamp,
      rate: fundingRateHistory.rate,
      granularity: fundingRateHistory.granularity,
      protocolSymbol: fundingRateHistory.protocolSymbol,
    }).from(fundingRateHistory)
      .where(and(
        eq(fundingRateHistory.dex, dex),
        eq(fundingRateHistory.symbol, symbol),
        gte(fundingRateHistory.timestamp, daysAgo(days)),
      ))
      .orderBy(orderBy)

    return c.json({
      dex,
      symbol,
      days,
      count: rows.length,
      rates: rows.map(r => ({
        timestamp: r.timestamp.getTime(),
        fundingRate: r.rate,
        granularity: r.granularity,
        protocolSymbol: r.protocolSymbol,
      })),
    })
  } catch (error) {
    log.error('[funding-rates-history-by-dex] Error:', error instanceof Error ? error.message : error)
    return c.json({ error: 'Failed to fetch funding rate history' }, 500)
  }
}
