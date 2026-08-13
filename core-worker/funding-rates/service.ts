import { db } from '@paystream/db'
import { fundingRateHistory } from '@paystream/db/schema'
import { lt, sql } from 'drizzle-orm'
import { log } from '../utils/log'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'
import { hoursAgo } from './utils'
import type { FundingRateRecord, DexName } from './types'
import * as hyperliquid from './fetchers/hyperliquid'
import * as pacifica from './fetchers/pacifica'
import * as aster from './fetchers/aster'
import * as lighter from './fetchers/lighter'
import * as zo from './fetchers/zo'
import * as phoenix from './fetchers/phoenix'

const UPSERT_BATCH_SIZE = 500
const RETENTION_HOURS = 30 * 24

export async function collectAndStoreFundingRates(): Promise<{
  totalRecords: number
  byDex: Record<string, number>
  duration: number
}> {
  const startTime = Date.now()
  const byDex: Record<string, number> = {}

  try {
    const since = hoursAgo(RETENTION_HOURS)

    // Union symbols from every venue so non-HL-listed markets aren't dropped.
    // Each fetcher filters the input list down to its own universe internally.
    const [hlSymbols, pacSymbols, astSymbols, zoSymbols, phoenixSymbols] = await Promise.all([
      hyperliquid.discoverSymbols().then(arr => arr.map(s => s.canonical)),
      pacifica.discoverSymbols(),
      aster.discoverSymbols(),
      zo.discoverSymbols(),
      phoenix.discoverSymbols(),
    ])
    const allSymbols = Array.from(new Set([
      ...hlSymbols,
      ...pacSymbols,
      ...astSymbols,
      ...zoSymbols,
      ...phoenixSymbols,
    ]))

    // Fetch DEXes sequentially
    const results: [DexName, FundingRateRecord[]][] = []

    for (const [name, fetcher] of [
      ['hyperliquid', () => hyperliquid.fetchHistoricalRates(since, allSymbols)],
      ['pacifica', () => pacifica.fetchHistoricalRates(since, allSymbols)],
      ['aster', () => aster.fetchHistoricalRates(since, allSymbols)],
      ['lighter', () => lighter.fetchHistoricalRates(since)],
      ['01', () => zo.fetchHistoricalRates(since, allSymbols)],
      ['phoenix', () => phoenix.fetchHistoricalRates(since, allSymbols)],
    ] as [DexName, () => Promise<FundingRateRecord[]>][]) {
      try {
        const records = await fetcher()
        results.push([name, records])
      } catch (err) {
        results.push([name, []])
        log.error(`[funding-rates] ${name} fetcher failed:`, err)
        sendOpsAlert({
          key: `funding-${name}-failed`,
          severity: AlertSeverity.WARNING,
          title: `${name} funding rate fetcher failed`,
          message: `Fetcher threw an error: ${err instanceof Error ? err.message : String(err)}`,
          service: 'core-worker',
          error: err,
        })
      }
    }

    // Collect all records
    const allRecords: FundingRateRecord[] = []
    for (const [name, records] of results) {
      byDex[name] = records.length
      allRecords.push(...records)
    }

    // Batch upsert into DB
    if (allRecords.length > 0) {
      await batchUpsert(allRecords)
    }

    // Prune records older than the retained 30-day history window.
    const pruned = await pruneOldRecords()

    const duration = (Date.now() - startTime) / 1000
    const totalRecords = allRecords.length
    const summary = Object.entries(byDex).map(([d, c]) => `${d}:${c}`).join(' ')
    log.info(`[funding-rates] Done: ${totalRecords} records upserted in ${duration.toFixed(0)}s, pruned ${pruned} | ${summary}`)

    // Alert if any DEX returned 0 records while others succeeded (stale data)
    for (const [dex, count] of Object.entries(byDex)) {
      if (count === 0 && totalRecords > 0) {
        sendOpsAlert({
          key: `funding-${dex}-stale`,
          severity: AlertSeverity.WARNING,
          title: `Funding data stale: ${dex}`,
          message: `${dex} returned 0 records this cycle while others succeeded. Summary: ${summary}`,
          service: 'core-worker',
        })
      }
    }

    return { totalRecords, byDex, duration }
  } catch (error) {
    log.error('[funding-rates] Collection failed:', error)
    sendOpsAlert({
      key: 'funding-collection-failed',
      severity: AlertSeverity.CRITICAL,
      title: 'Funding rate collection failed entirely',
      message: error instanceof Error ? error.message : String(error),
      service: 'core-worker',
      error,
    })
    throw error
  }
}

async function pruneOldRecords(): Promise<number> {
  const cutoff = hoursAgo(RETENTION_HOURS)
  const deleted = await db.delete(fundingRateHistory)
    .where(lt(fundingRateHistory.timestamp, cutoff))
    .returning({ id: fundingRateHistory.id })
  return deleted.length
}

async function batchUpsert(records: FundingRateRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
    const batch = records.slice(i, i + UPSERT_BATCH_SIZE)
    await db.insert(fundingRateHistory)
      .values(batch.map(rec => ({
        dex: rec.dex,
        symbol: rec.symbol,
        protocolSymbol: rec.protocolSymbol,
        timestamp: rec.timestamp,
        rate: rec.rate,
        granularity: rec.granularity,
      })))
      .onConflictDoUpdate({
        target: [fundingRateHistory.dex, fundingRateHistory.symbol, fundingRateHistory.timestamp],
        set: {
          rate: sql`excluded.rate`,
          protocolSymbol: sql`excluded.protocol_symbol`,
        },
      })
  }
}
