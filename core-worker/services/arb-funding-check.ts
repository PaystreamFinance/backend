import { db } from '@paystream/db'
import { fundingRateHistory } from '@paystream/db/schema'
import { eq, and, gte } from 'drizzle-orm'
import { floorToHour, canonicalizeSymbol } from '@paystream/perps'
import { log } from '../utils/log'

/** Number of hours to look back for funding rate analysis */
const LOOKBACK_HOURS = 12

/** Number of negative net-funding hours required to trigger a close */
const NEGATIVE_HOURS_REQUIRED = 6

/**
 * For 8h-granularity records, find the 8h window start for a given hour.
 * 8h windows are: 0-7, 8-15, 16-23
 */
function floor8hWindow(date: Date): number {
  return Math.floor(date.getUTCHours() / 8) * 8
}

/**
 * Build a map of hourly rates from funding_rate_history records.
 * For 8h granularity records, the rate is divided by 8 and spread across
 * all hours in the 8h window.
 *
 * `protocol` is required so we can normalize Lighter's rates: Lighter publishes
 * an 8h funding rate refreshed every hour and the fetcher stores it as `1h`
 * granularity, so each row is an 8h rate at an hourly cadence — divide by 8 to
 * get an apples-to-apples hourly rate against other dexes' true 1h rates.
 */
function buildHourlyRateMap(
  records: { rate: number; timestamp: Date; granularity: string }[],
  protocol: string,
): Map<string, number> {
  const map = new Map<string, number>()
  const isLighter = protocol.toLowerCase() === 'lighter'

  for (const record of records) {
    if (record.granularity === '8h') {
      // Spread 8h rate across constituent hours
      const hourlyRate = record.rate / 8
      const windowStart = floor8hWindow(record.timestamp)
      const base = new Date(record.timestamp)
      for (let h = 0; h < 8; h++) {
        const hour = new Date(Date.UTC(
          base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(),
          windowStart + h,
        ))
        const key = hour.toISOString()
        if (!map.has(key)) {
          map.set(key, hourlyRate)
        }
      }
    } else {
      // 1h granularity. Lighter's per-hour rows are actually 8h rates updated
      // hourly, so we still divide by 8 to compare against true hourly rates.
      const key = floorToHour(record.timestamp).toISOString()
      map.set(key, isLighter ? record.rate / 8 : record.rate)
    }
  }

  return map
}

/**
 * Check whether a funding-rate-based auto-close should fire.
 *
 * Fetches the last 12 hours of funding rate data for both legs (each using
 * its own per-dex ticker for cross-ticker pairs), matches hourly data
 * points, and counts how many have negative net funding
 * (shortRate - longRate < 0 = strategy losing).
 *
 * Close triggers when 6+ out of the matched hours are negative.
 */
export async function checkFundingRateClose(
  longSymbol: string,
  shortSymbol: string,
  longProtocol: string,
  shortProtocol: string,
  openedAt: Date,
): Promise<{ shouldClose: boolean; negCount: number; details: string }> {
  try {
    // Funding fetchers store canonical symbols (e.g. `kPEPE` → `1000PEPE`),
    // but pair rows persist the dex-native ticker for position lookups. Match
    // both shapes by canonicalizing the lookup key here.
    const longUpper = canonicalizeSymbol(longSymbol.toUpperCase())
    const shortUpper = canonicalizeSymbol(shortSymbol.toUpperCase())
    const rollingCutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000)
    // Never look at rates from before the position was opened
    const cutoff = openedAt > rollingCutoff ? openedAt : rollingCutoff

    const [longHistory, shortHistory] = await Promise.all([
      db.select({
        rate: fundingRateHistory.rate,
        timestamp: fundingRateHistory.timestamp,
        granularity: fundingRateHistory.granularity,
      })
        .from(fundingRateHistory)
        .where(and(
          eq(fundingRateHistory.dex, longProtocol.toLowerCase()),
          eq(fundingRateHistory.symbol, longUpper),
          gte(fundingRateHistory.timestamp, cutoff),
        )),
      db.select({
        rate: fundingRateHistory.rate,
        timestamp: fundingRateHistory.timestamp,
        granularity: fundingRateHistory.granularity,
      })
        .from(fundingRateHistory)
        .where(and(
          eq(fundingRateHistory.dex, shortProtocol.toLowerCase()),
          eq(fundingRateHistory.symbol, shortUpper),
          gte(fundingRateHistory.timestamp, cutoff),
        )),
    ])

    if (longHistory.length === 0 || shortHistory.length === 0) {
      return {
        shouldClose: false,
        negCount: 0,
        details: `Insufficient history: long=${longHistory.length} short=${shortHistory.length}`,
      }
    }

    const longRates = buildHourlyRateMap(longHistory, longProtocol)
    const shortRates = buildHourlyRateMap(shortHistory, shortProtocol)

    // Match hours present in both protocols
    const matchedHours: { hour: string; net: number }[] = []
    for (const [hourKey, longRate] of longRates) {
      const shortRate = shortRates.get(hourKey)
      if (shortRate !== undefined) {
        matchedHours.push({ hour: hourKey, net: shortRate - longRate })
      }
    }

    if (matchedHours.length === 0) {
      return {
        shouldClose: false,
        negCount: 0,
        details: `No matching hours between ${longProtocol} and ${shortProtocol}`,
      }
    }

    // Sort by hour descending for display
    matchedHours.sort((a, b) => b.hour.localeCompare(a.hour))

    const negCount = matchedHours.filter(h => h.net < 0).length
    const shouldClose = negCount >= NEGATIVE_HOURS_REQUIRED

    const formatted = matchedHours
      .slice(0, LOOKBACK_HOURS)
      .map(h => {
        const hourLabel = new Date(h.hour).getUTCHours().toString().padStart(2, '0')
        return `h${hourLabel}: ${(h.net * 100).toFixed(4)}%`
      })
      .join(', ')

    const avgNet = matchedHours.reduce((a, b) => a + b.net, 0) / matchedHours.length

    return {
      shouldClose,
      negCount,
      details: shouldClose
        ? `Funding negative ${negCount}/${matchedHours.length}h: ${formatted} | avg=${(avgNet * 100).toFixed(4)}%`
        : `Net rates: ${negCount}/${matchedHours.length} negative: ${formatted}`,
    }
  } catch (e) {
    const label = longSymbol === shortSymbol ? longSymbol : `${longSymbol}/${shortSymbol}`
    log.error(`[arb-funding-check] Error checking funding for ${label}:`, e)
    return { shouldClose: false, negCount: 0, details: `Error: ${e instanceof Error ? e.message : 'unknown'}` }
  }
}
