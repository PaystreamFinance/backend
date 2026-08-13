import type { FundingRateRecord } from '../types'
import { canonicalizeSymbol, sleep } from '../utils'
import { log } from '../../logger'

const PACIFICA_API = 'https://api.pacifica.fi/api/v1'
const REQUEST_DELAY_MS = 500
const SYMBOL_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

interface PacificaFundingRecord {
  funding_rate: string
  created_at: number // Unix timestamp in milliseconds
}

interface PacificaSymbolInfo {
  symbol: string
}

let symbolSetCache: Set<string> | null = null
let symbolSetTimestamp = 0

async function getSymbolSet(): Promise<Set<string> | null> {
  if (symbolSetCache && Date.now() - symbolSetTimestamp < SYMBOL_CACHE_TTL_MS) {
    return symbolSetCache
  }
  try {
    const res = await fetch(`${PACIFICA_API}/info`)
    if (!res.ok) {
      log.warn(`[pacifica] Symbols discovery failed: ${res.status}`)
      return symbolSetCache
    }
    const body = await res.json() as { data?: PacificaSymbolInfo[] }
    const symbols = body?.data
    if (!Array.isArray(symbols)) return symbolSetCache

    const set = new Set<string>()
    for (const s of symbols) {
      const canonical = canonicalizeSymbol((s.symbol ?? '').toUpperCase())
      if (canonical) set.add(canonical)
    }
    symbolSetCache = set
    symbolSetTimestamp = Date.now()
    return set
  } catch (err) {
    log.error('[pacifica] Symbol discovery failed:', err)
    return symbolSetCache
  }
}

export async function discoverSymbols(): Promise<string[]> {
  const set = await getSymbolSet()
  return set ? Array.from(set) : []
}

export async function fetchHistoricalRates(
  since: Date | null,
  symbols?: string[],
): Promise<FundingRateRecord[]> {
  if (!symbols || symbols.length === 0) return []

  // Filter input to Pacifica's own universe so non-Pacifica symbols from the
  // unioned set don't each cost a 404 + 500ms delay. If discovery is down, fall
  // back to fetching everything to preserve existing behavior.
  const universe = await getSymbolSet()
  const targetSymbols = universe
    ? symbols.filter(s => universe.has(canonicalizeSymbol(s.toUpperCase())))
    : symbols

  const allRecords: FundingRateRecord[] = []

  for (const symbol of targetSymbols) {
    try {
      const records = await fetchForSymbol(symbol.toUpperCase(), since)
      allRecords.push(...records)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('400') && !msg.includes('404')) {
        log.error(`[pacifica] Fetch error for ${symbol}:`, err)
      }
    }
    await sleep(REQUEST_DELAY_MS)
  }

  log.info(`[pacifica] ${allRecords.length} records from ${targetSymbols.length}/${symbols.length} symbols`)
  return allRecords
}

async function fetchForSymbol(
  symbol: string,
  since: Date | null,
): Promise<FundingRateRecord[]> {
  const results: FundingRateRecord[] = []
  // Pacifica has no start_time param — `limit` is the only window control.
  // Records are ~hourly; size the request to the lookback window with a small
  // buffer so the 30-day retention window doesn't under-fetch hourly history.
  const hoursSince = since ? (Date.now() - since.getTime()) / 3_600_000 : 72
  const fetchLimit = Math.min(1000, Math.max(100, Math.ceil(hoursSince * 1.2)))

  const url = `${PACIFICA_API}/funding_rate/history?symbol=${symbol}&limit=${fetchLimit}`
  const res = await fetch(url)

  if (res.status === 400 || res.status === 404) return results

  if (res.status === 429) {
    log.warn(`[pacifica] 429 for ${symbol}, backing off 5s...`)
    await sleep(5000)
    const retry = await fetch(url)
    if (!retry.ok) return results
    const retryData = await retry.json() as { data: PacificaFundingRecord[] }
    return parseRecords(retryData?.data, symbol, since)
  }

  if (!res.ok) return results

  const data = await res.json() as { data: PacificaFundingRecord[] }
  return parseRecords(data?.data, symbol, since)
}

function parseRecords(
  records: PacificaFundingRecord[] | undefined,
  symbol: string,
  since: Date | null,
): FundingRateRecord[] {
  if (!Array.isArray(records) || records.length === 0) return []

  const canonical = canonicalizeSymbol(symbol)
  const results: FundingRateRecord[] = []

  for (const rec of records) {
    const rate = parseFloat(rec.funding_rate)
    if (isNaN(rate)) continue

    const timestamp = new Date(rec.created_at)
    if (since && timestamp <= since) continue

    results.push({
      dex: 'pacifica',
      symbol: canonical,
      protocolSymbol: symbol,
      timestamp,
      rate,
      granularity: '1h',
    })
  }

  return results
}
