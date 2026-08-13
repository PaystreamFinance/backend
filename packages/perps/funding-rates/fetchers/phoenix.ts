import type { FundingRateRecord } from '../types'
import { canonicalizeSymbol, sleep } from '../utils'
import { log } from '../../logger'
import { getPhoenixHttpClient } from '../../clients/phoenix-client'
import { baseFromPhoenixSymbol, normalizePhoenixSymbol } from '../../providers/phoenix-provider'

const REQUEST_DELAY_MS = 200
const PAGE_LIMIT = 1000

const httpClient = getPhoenixHttpClient()

interface PhoenixMarketEntry {
  base: string
  protocolSymbol: string
}

async function fetchMarkets(): Promise<PhoenixMarketEntry[]> {
  try {
    const configs = await httpClient.markets().getMarkets()
    const byBase = new Map<string, PhoenixMarketEntry>()
    for (const cfg of configs) {
      if (cfg.marketStatus !== 'active') continue
      const base = baseFromPhoenixSymbol(cfg.symbol)
      if (!base) continue
      // Multiple active listings can share the same base (duplicate assetIds);
      // keep the first stable mapping — funding history is per-symbol anyway.
      if (!byBase.has(base)) {
        byBase.set(base, { base, protocolSymbol: normalizePhoenixSymbol(cfg.symbol) })
      }
    }
    return Array.from(byBase.values())
  } catch (err) {
    log.warn('[phoenix] Markets discovery failed:', err)
    return []
  }
}

export async function discoverSymbols(): Promise<string[]> {
  const markets = await fetchMarkets()
  return markets.map(m => m.base)
}

export async function fetchHistoricalRates(
  since: Date | null,
  symbols?: string[],
): Promise<FundingRateRecord[]> {
  if (!symbols || symbols.length === 0) return []

  const markets = await fetchMarkets()
  if (markets.length === 0) return []

  const requested = new Set(symbols.map(s => canonicalizeSymbol(s.toUpperCase())))
  const targets = markets.filter(m => requested.has(m.base))

  const allRecords: FundingRateRecord[] = []

  for (const market of targets) {
    try {
      const records = await fetchForMarket(market, since)
      allRecords.push(...records)
    } catch (err) {
      log.error(`[phoenix] Fetch error for ${market.protocolSymbol}:`, err)
    }
    await sleep(REQUEST_DELAY_MS)
  }

  log.info(`[phoenix] ${allRecords.length} records from ${targets.length}/${symbols.length} symbols`)
  return allRecords
}

async function fetchForMarket(
  market: PhoenixMarketEntry,
  since: Date | null,
): Promise<FundingRateRecord[]> {
  const results: FundingRateRecord[] = []

  // Phoenix funding is hourly. The endpoint expects request timestamps in
  // milliseconds even though response `timestamp` values come back in seconds.
  const nowMs = Date.now()
  const startTime = since ? since.getTime() : undefined

  const response = await httpClient.funding().getFundingRateHistory(market.protocolSymbol, {
    startTime,
    endTime: nowMs,
    limit: PAGE_LIMIT,
  })

  const rates = response?.rates
  if (!Array.isArray(rates) || rates.length === 0) return results

  for (const point of rates) {
    // `fundingRatePercentage` is expressed as a percent (1.0 == 1%); divide
    // by 100 to land in the per-period decimal convention used by the table.
    const pct = parseFloat(point.fundingRatePercentage)
    if (!Number.isFinite(pct)) continue
    const rate = pct / 100

    const tsSec = Number(point.timestamp)
    if (!Number.isFinite(tsSec)) continue
    const timestamp = new Date(tsSec * 1000)
    if (since && timestamp <= since) continue

    results.push({
      dex: 'phoenix',
      symbol: market.base,
      protocolSymbol: market.protocolSymbol,
      timestamp,
      rate,
      granularity: '1h',
    })
  }

  return results
}
