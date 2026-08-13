#!/usr/bin/env bun
/**
 * Funding Rate Health Check
 *
 * Analyzes the funding_rate_history table and reports:
 * - Data freshness per dex/symbol (how old is the latest record)
 * - Coverage gaps (missing hours)
 * - Per-dex record counts and symbol counts
 * - Symbols that may have stopped updating (stale > 3h)
 * - Potential rate-limiting indicators (sudden drop in record count)
 *
 * Usage:
 *   bun run scripts/funding-rate-health.ts                  # full report
 *   bun run scripts/funding-rate-health.ts --dex pacifica   # filter by dex
 *   bun run scripts/funding-rate-health.ts --symbol BERA    # filter by symbol
 *   bun run scripts/funding-rate-health.ts --stale-only     # only show stale entries
 */

import { db } from '@paystream/db'
import { fundingRateHistory } from '@paystream/db/schema'
import { sql, desc, eq, and, type SQL } from 'drizzle-orm'

// --- CLI args ---
const args = process.argv.slice(2)
const dexFilter = args.includes('--dex') ? args[args.indexOf('--dex') + 1]?.toLowerCase() : null
const symbolFilter = args.includes('--symbol') ? args[args.indexOf('--symbol') + 1]?.toUpperCase() : null
const staleOnly = args.includes('--stale-only')

const STALE_THRESHOLD_HOURS = 3

function timeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m ago`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h ago`
}

function formatRate(rate: number): string {
  const pct = (rate * 100).toFixed(4)
  return `${pct}%`
}

async function main() {
  console.log('=== Funding Rate Health Check ===\n')

  // --- 1. Overall stats ---
  const [totalResult] = await db.select({
    count: sql<number>`count(*)`,
    symbols: sql<number>`count(distinct symbol)`,
    dexes: sql<number>`count(distinct dex)`,
    oldest: sql<string>`min(timestamp)`,
    newest: sql<string>`max(timestamp)`,
  }).from(fundingRateHistory)

  if (!totalResult || totalResult.count === 0) {
    console.log('❌ No records in funding_rate_history table.')
    process.exit(0)
  }

  const overallOldest = new Date(totalResult.oldest!)
  const overallNewest = new Date(totalResult.newest!)

  console.log('📊 Overall Stats')
  console.log(`   Total records:  ${totalResult.count.toLocaleString()}`)
  console.log(`   Unique symbols: ${totalResult.symbols}`)
  console.log(`   Active DEXes:   ${totalResult.dexes}`)
  console.log(`   Oldest record:  ${overallOldest.toISOString()} (${timeAgo(overallOldest)})`)
  console.log(`   Newest record:  ${overallNewest.toISOString()} (${timeAgo(overallNewest)})`)
  console.log()

  // --- 2. Per-dex summary ---
  const dexStats = await db.select({
    dex: fundingRateHistory.dex,
    count: sql<number>`count(*)`,
    symbols: sql<number>`count(distinct symbol)`,
    oldest: sql<string>`min(timestamp)`,
    newest: sql<string>`max(timestamp)`,
    avgRate: sql<number>`avg(rate)`,
  })
    .from(fundingRateHistory)
    .groupBy(fundingRateHistory.dex)
    .orderBy(desc(sql`count(*)`))

  console.log('📡 Per-DEX Summary')
  console.log('   ┌─────────────────┬──────────┬─────────┬──────────────────────┬──────────────┐')
  console.log('   │ DEX             │ Records  │ Symbols │ Latest Record        │ Freshness    │')
  console.log('   ├─────────────────┼──────────┼─────────┼──────────────────────┼──────────────┤')
  for (const d of dexStats) {
    if (dexFilter && d.dex.toLowerCase() !== dexFilter) continue
    const newest = new Date(d.newest!)
    const fresh = timeAgo(newest)
    const isStale = (Date.now() - newest.getTime()) > STALE_THRESHOLD_HOURS * 3600_000
    const marker = isStale ? ' ⚠️' : ''
    console.log(
      `   │ ${d.dex.padEnd(15)} │ ${String(d.count).padStart(8)} │ ${String(d.symbols).padStart(7)} │ ${newest.toISOString().slice(0, 19).padEnd(20)} │ ${fresh.padEnd(12)}${marker} │`
    )
  }
  console.log('   └─────────────────┴──────────┴─────────┴──────────────────────┴──────────────┘')
  console.log()

  // --- 3. Freshness per dex+symbol (latest record for each combo) ---
  const conditions: SQL[] = []
  if (dexFilter) conditions.push(eq(fundingRateHistory.dex, dexFilter))
  if (symbolFilter) conditions.push(sql`upper(${fundingRateHistory.symbol}) = ${symbolFilter}`)

  const freshness = await db.select({
    dex: fundingRateHistory.dex,
    symbol: fundingRateHistory.symbol,
    count: sql<number>`count(*)`,
    newest: sql<string>`max(timestamp)`,
    oldest: sql<string>`min(timestamp)`,
    latestRate: sql<number>`(array_agg(rate order by timestamp desc))[1]`,
  })
    .from(fundingRateHistory)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(fundingRateHistory.dex, fundingRateHistory.symbol)
    .orderBy(fundingRateHistory.dex, fundingRateHistory.symbol)

  // Identify stale entries
  const staleEntries = freshness.filter(f => {
    const ageMs = Date.now() - new Date(f.newest!).getTime()
    return ageMs > STALE_THRESHOLD_HOURS * 3600_000
  })

  const freshEntries = freshness.filter(f => {
    const ageMs = Date.now() - new Date(f.newest!).getTime()
    return ageMs <= STALE_THRESHOLD_HOURS * 3600_000
  })

  // --- 4. Stale symbols ---
  if (staleEntries.length > 0) {
    console.log(`⚠️  Stale Symbols (no data in last ${STALE_THRESHOLD_HOURS}h) — ${staleEntries.length} entries`)
    console.log('   ┌─────────────────┬──────────┬──────────┬──────────────────────┬──────────────┬────────────┐')
    console.log('   │ DEX             │ Symbol   │ Records  │ Latest Record        │ Freshness    │ Last Rate  │')
    console.log('   ├─────────────────┼──────────┼──────────┼──────────────────────┼──────────────┼────────────┤')
    for (const f of staleEntries.sort((a, b) => new Date(b.newest!).getTime() - new Date(a.newest!).getTime())) {
      const newest = new Date(f.newest!)
      console.log(
        `   │ ${f.dex.padEnd(15)} │ ${f.symbol.padEnd(8)} │ ${String(f.count).padStart(8)} │ ${newest.toISOString().slice(0, 19).padEnd(20)} │ ${timeAgo(newest).padEnd(12)} │ ${formatRate(f.latestRate).padStart(10)} │`
      )
    }
    console.log('   └─────────────────┴──────────┴──────────┴──────────────────────┴──────────────┴────────────┘')
    console.log()
  }

  if (staleOnly) {
    if (staleEntries.length === 0) console.log('✅ No stale entries found.\n')
    process.exit(0)
  }

  // --- 5. Coverage gaps: check for missing hourly records in the last 24h ---
  console.log('🔍 Coverage Gaps (missing hours in last 24h)')
  const last24hIso = new Date(Date.now() - 24 * 3600_000).toISOString()
  const gapConditions: SQL[] = [sql`timestamp >= ${last24hIso}::timestamptz`]
  if (dexFilter) gapConditions.push(sql`dex = ${dexFilter}`)
  if (symbolFilter) gapConditions.push(sql`upper(symbol) = ${symbolFilter}`)

  const gapQuery = await db.select({
    dex: fundingRateHistory.dex,
    symbol: fundingRateHistory.symbol,
    hours: sql<number>`count(distinct date_trunc('hour', timestamp))`,
  })
    .from(fundingRateHistory)
    .where(and(...gapConditions))
    .groupBy(fundingRateHistory.dex, fundingRateHistory.symbol)
    .orderBy(sql`count(distinct date_trunc('hour', timestamp))`)

  const gapsFound = gapQuery.filter(g => g.hours < 20) // expect ~24, flag if < 20
  if (gapsFound.length > 0) {
    console.log(`   Found ${gapsFound.length} dex/symbol pairs with < 20 hours of data in last 24h:`)
    for (const g of gapsFound.slice(0, 30)) {
      const bar = '█'.repeat(g.hours) + '░'.repeat(Math.max(0, 24 - g.hours))
      console.log(`   ${g.dex.padEnd(15)} ${g.symbol.padEnd(8)} ${bar} ${g.hours}/24h`)
    }
    if (gapsFound.length > 30) console.log(`   ... and ${gapsFound.length - 30} more`)
  } else {
    console.log('   ✅ All active pairs have good coverage (20+ hours in last 24h)')
  }
  console.log()

  // --- 6. Ingestion timeline: records per hour for each dex (last 6h) ---
  console.log('📈 Ingestion Timeline (records inserted per collection hour, last 6h)')
  const last6hIso = new Date(Date.now() - 6 * 3600_000).toISOString()
  const timeline = await db.select({
    dex: fundingRateHistory.dex,
    hour: sql<string>`date_trunc('hour', created_at)`,
    count: sql<number>`count(*)`,
  })
    .from(fundingRateHistory)
    .where(sql`created_at >= ${last6hIso}::timestamptz`)
    .groupBy(fundingRateHistory.dex, sql`date_trunc('hour', created_at)`)
    .orderBy(sql`date_trunc('hour', created_at)`, fundingRateHistory.dex)

  if (timeline.length === 0) {
    console.log('   No records created in last 6h (table was likely truncated recently)')
  } else {
    // Group by hour
    const byHour = new Map<string, Map<string, number>>()
    const allDexes = new Set<string>()
    for (const t of timeline) {
      const hourKey = new Date(t.hour!).toISOString().slice(0, 13)
      allDexes.add(t.dex)
      if (!byHour.has(hourKey)) byHour.set(hourKey, new Map())
      byHour.get(hourKey)!.set(t.dex, t.count)
    }

    const dexList = [...allDexes].sort()
    const header = '   ' + 'Hour'.padEnd(16) + dexList.map(d => d.padStart(12)).join('')
    console.log(header)
    console.log('   ' + '─'.repeat(16 + dexList.length * 12))
    for (const [hour, dexMap] of byHour) {
      const cols = dexList.map(d => {
        const count = dexMap.get(d) || 0
        return (count === 0 ? '-' : String(count)).padStart(12)
      }).join('')
      console.log(`   ${hour.padEnd(16)}${cols}`)
    }
  }
  console.log()

  // --- 7. Per-dex symbol list (if filtered) ---
  if (symbolFilter) {
    console.log(`📋 All Records for ${symbolFilter}`)
    const records = await db.select({
      dex: fundingRateHistory.dex,
      timestamp: fundingRateHistory.timestamp,
      rate: fundingRateHistory.rate,
      createdAt: fundingRateHistory.createdAt,
    })
      .from(fundingRateHistory)
      .where(sql`upper(${fundingRateHistory.symbol}) = ${symbolFilter}`)
      .orderBy(desc(fundingRateHistory.timestamp))
      .limit(50)

    for (const r of records) {
      const ts = new Date(r.timestamp!)
      const created = new Date(r.createdAt)
      console.log(`   ${r.dex.padEnd(15)} ${ts.toISOString().slice(0, 19)} ${formatRate(r.rate).padStart(10)}  (ingested ${timeAgo(created)})`)
    }
    console.log()
  }

  // --- 8. Summary ---
  console.log('📝 Summary')
  console.log(`   Active DEXes:     ${dexStats.length}`)
  console.log(`   Total pairs:      ${freshness.length}`)
  console.log(`   Fresh pairs:      ${freshEntries.length}`)
  console.log(`   Stale pairs:      ${staleEntries.length}`)
  if (gapsFound.length > 0) {
    console.log(`   Pairs with gaps:  ${gapsFound.length}`)
  }
  console.log()

  process.exit(0)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
