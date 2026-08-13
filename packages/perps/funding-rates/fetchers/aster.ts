import type { FundingRateRecord } from '../types'
import { sleep } from '../utils'
import { log } from '../../logger'

const ASTER_API = 'https://fapi.asterdex.com/fapi/v1'
const REQUEST_DELAY_MS = 300
const RATE_LIMIT_BACKOFF_MS = 5_000
const MAX_CONSECUTIVE_FAILURES = 10

interface AsterFundingRecord {
  symbol: string
  fundingRate: string
  fundingTime: number
  markPrice?: string
}

// Cache: canonical symbol → Aster USDT pair (e.g. SOL → SOLUSDT)
let asterSymbolMap: Map<string, string> | null = null
let symbolMapTimestamp = 0
const SYMBOL_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/** Discover USDT perp symbols from Aster */
async function getAsterSymbols(): Promise<Map<string, string>> {
  if (asterSymbolMap && (Date.now() - symbolMapTimestamp) < SYMBOL_CACHE_TTL_MS) return asterSymbolMap

  const res = await fetch(`${ASTER_API}/fundingRate?limit=1000`)
  if (!res.ok) {
    log.warn(`[aster] Discovery failed: ${res.status}`)
    return asterSymbolMap ?? new Map()
  }

  const data = await res.json() as AsterFundingRecord[]
  if (!Array.isArray(data)) return asterSymbolMap ?? new Map()

  const map = new Map<string, string>()
  for (const item of data) {
    const raw = item.symbol.toUpperCase()
    if (!raw.endsWith('USDT')) continue
    if (raw.startsWith('SHIELD')) continue
    const canonical = raw.replace(/USDT$/, '')
    if (!map.has(canonical)) {
      map.set(canonical, raw)
    }
  }

  asterSymbolMap = map
  symbolMapTimestamp = Date.now()
  return asterSymbolMap
}

export async function discoverSymbols(): Promise<string[]> {
  try {
    const map = await getAsterSymbols()
    return Array.from(map.keys())
  } catch (err) {
    log.error('[aster] Symbol discovery failed:', err)
    return []
  }
}

export async function fetchHistoricalRates(
  since: Date | null,
  symbols?: string[],
): Promise<FundingRateRecord[]> {
  const map = await getAsterSymbols()
  if (map.size === 0) return []

  // Determine which symbols to fetch
  const targetSymbols = symbols && symbols.length > 0
    ? symbols.filter(s => map.has(s.toUpperCase()))
    : Array.from(map.keys())

  const allRecords: FundingRateRecord[] = []
  let fetched = 0
  let consecutiveFailures = 0

  for (const symbol of targetSymbols) {
    const asterPair = map.get(symbol.toUpperCase())
    if (!asterPair) continue

    try {
      const params = new URLSearchParams({
        symbol: asterPair,
        // limit=1000 covers any reasonable window (30d × 3 settlements/day = 90 records).
        limit: '1000',
      })
      if (since) {
        params.set('startTime', since.getTime().toString())
      }

      const res = await fetch(`${ASTER_API}/fundingRate?${params}`)

      if (res.status === 429) {
        consecutiveFailures++
        log.warn(`[aster] Rate limited on ${asterPair}, backing off ${RATE_LIMIT_BACKOFF_MS}ms...`)
        await sleep(RATE_LIMIT_BACKOFF_MS)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log.error(`[aster] ${consecutiveFailures} consecutive failures, aborting`)
          break
        }
        continue
      }

      if (res.status === 400 || res.status === 404) {
        consecutiveFailures = 0
        continue
      }
      if (!res.ok) {
        consecutiveFailures++
        log.warn(`[aster] ${asterPair} → ${res.status}`)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log.error(`[aster] ${consecutiveFailures} consecutive failures, aborting`)
          break
        }
        continue
      }

      consecutiveFailures = 0
      const data = await res.json() as AsterFundingRecord[]
      if (!Array.isArray(data)) continue

      for (const item of data) {
        const rate = parseFloat(item.fundingRate)
        if (isNaN(rate)) continue

        const timestamp = new Date(item.fundingTime)
        if (since && timestamp < since) continue

        allRecords.push({
          dex: 'aster',
          symbol: symbol.toUpperCase(),
          protocolSymbol: asterPair,
          timestamp,
          rate,
          granularity: '8h',
        })
      }

      fetched++
    } catch (err) {
      consecutiveFailures++
      log.error(`[aster] Fetch error for ${asterPair}:`, err)
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log.error(`[aster] ${consecutiveFailures} consecutive failures, aborting`)
        break
      }
    }

    await sleep(REQUEST_DELAY_MS)
  }

  log.info(`[aster] ${allRecords.length} records from ${fetched}/${targetSymbols.length} symbols`)
  return allRecords
}
