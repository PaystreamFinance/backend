import type { FundingRateRecord } from '../types'
import { canonicalizeSymbol, sleep } from '../utils'
import { log } from '../../logger'
import { createZoClient, ZO_MAINNET_BASE } from '../../clients/zo-client'

const REQUEST_DELAY_MS = 200
const PAGE_SIZE = 255
const MAX_PAGES = 8

const zoClient = createZoClient()

interface ZoHistoryItem {
  marketId: number
  time: string           // ISO 8601
  actionId: number
  fundingIndex: number
  fundingRate: number    // Decimal, hourly
  indexPrice: number
  markPrice: number
}

interface ZoHistoryResponse {
  items: ZoHistoryItem[]
  nextStartInclusive: number | null
}

/**
 * Strip the `USD` quote suffix and canonicalize the base symbol.
 */
function baseFromZoSymbol(zoSymbol: string): string {
  const upper = zoSymbol.toUpperCase()
  const base = upper.endsWith('USD') ? upper.slice(0, -'USD'.length) : upper
  return canonicalizeSymbol(base)
}

/** Derive canonical symbols + marketId map from the shared /info cache. */
async function fetchInfo(): Promise<{ symbols: string[]; idBySymbol: Map<string, number> }> {
  try {
    const info = await zoClient.getInfoCached()
    const idBySymbol = new Map<string, number>()
    const symbols: string[] = []
    for (const m of info.markets ?? []) {
      const canonical = baseFromZoSymbol(m.symbol)
      if (!canonical) continue
      idBySymbol.set(canonical, m.marketId)
      symbols.push(canonical)
    }
    return { symbols, idBySymbol }
  } catch (err) {
    log.warn('[01] /info failed:', err)
    return { symbols: [], idBySymbol: new Map() }
  }
}

export async function discoverSymbols(): Promise<string[]> {
  try {
    const { symbols } = await fetchInfo()
    return symbols
  } catch (err) {
    log.error('[01] Symbol discovery failed:', err)
    return []
  }
}

export async function fetchHistoricalRates(
  since: Date | null,
  symbols?: string[],
): Promise<FundingRateRecord[]> {
  if (!symbols || symbols.length === 0) return []

  const { idBySymbol } = await fetchInfo()
  if (idBySymbol.size === 0) return []

  const allRecords: FundingRateRecord[] = []

  for (const symbol of symbols) {
    const canonical = canonicalizeSymbol(symbol.toUpperCase())
    const marketId = idBySymbol.get(canonical)
    if (marketId === undefined) continue

    try {
      const records = await fetchForMarket(marketId, canonical, since)
      allRecords.push(...records)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('404')) {
        log.error(`[01] Fetch error for ${canonical} (marketId=${marketId}):`, err)
      }
    }
    await sleep(REQUEST_DELAY_MS)
  }

  log.info(`[01] ${allRecords.length} records from ${symbols.length} symbols`)
  return allRecords
}

async function fetchForMarket(
  marketId: number,
  canonicalSymbol: string,
  since: Date | null,
): Promise<FundingRateRecord[]> {
  const protocolSymbol = `${canonicalSymbol}USD`
  const results: FundingRateRecord[] = []
  const seenTimestamps = new Set<number>()

  let cursor: number | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      pageSize: String(PAGE_SIZE),
    })
    if (cursor !== null) {
      params.set('startInclusive', String(cursor))
    }

    const res = await fetch(`${ZO_MAINNET_BASE}/market/${marketId}/history/PT1H?${params.toString()}`)
    if (res.status === 404) return results
    if (!res.ok) {
      throw new Error(`01 PT1H history failed for marketId=${marketId}: ${res.status}`)
    }

    const data = await res.json() as ZoHistoryResponse
    if (!Array.isArray(data.items) || data.items.length === 0) break

    let reachedSince = false

    for (const item of data.items) {
      const rate = item.fundingRate
      if (!Number.isFinite(rate)) continue

      const timestamp = new Date(item.time)
      const tsMs = timestamp.getTime()
      if (Number.isNaN(tsMs)) continue
      if (since && timestamp <= since) {
        reachedSince = true
        continue
      }
      if (seenTimestamps.has(tsMs)) continue

      seenTimestamps.add(tsMs)
      results.push({
        dex: '01',
        symbol: canonicalSymbol,
        protocolSymbol,
        timestamp,
        rate,
        granularity: '1h',
      })
    }

    if (reachedSince || data.nextStartInclusive == null) break
    if (cursor !== null && data.nextStartInclusive === cursor) break

    cursor = data.nextStartInclusive
    await sleep(REQUEST_DELAY_MS)
  }

  return results
}
