import type { Context } from 'hono'
import { getCachedMarketData } from '@paystream/perps/registry'
import { getHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import type { Hip3DexName, Hip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import { db } from '@paystream/db'
import { fundingRateHistory } from '@paystream/db/schema'
import { desc, gte } from 'drizzle-orm'
import { log } from '../../utils/log'

interface FundingStats {
  interval: string
  raw_bps: number
  normalized: {
    label: string
    hr1_bps: number
    hr8_bps: number
    daily_bps: number
    yearly_apr_pct: number
  }
}

interface MarketData {
  fundingRate: string | null
  fundingRateApr: string | null
  averageFundingRate: string | null // Average funding rate from historical data
  openInterest: { long: number; short: number } | null
  oraclePrice: number
  markPrice: number | null
  indexPrice: number | null
  maxLeverage: number | null
  fundingIntervalHours: number | null
  nextFundingTime: number | null
  fundingStats: FundingStats | null
  fees?: {
    taker: string
    maker: string
  }
}

type MarketResponse = {
  symbol: string
  aster: MarketData | null
  lighter: MarketData | null
  pacifica: MarketData | null
  hyperliquid: MarketData | null
  '01': MarketData | null
  phoenix: MarketData | null
  maxArb: string | null
  maxArbApr: string | null
  longProtocol: string | null
  shortProtocol: string | null
} & Partial<Record<Hip3ProtocolId, MarketData | null>>

function toMarketData(market: any, averageFundingRate?: string | null, fundingStats?: FundingStats | null): MarketData {
  return {
    fundingRate: market.fundingRate != null ? `${(market.fundingRate * 100).toFixed(5)}%` : null,
    fundingRateApr: market.fundingRateApr != null ? `${(market.fundingRateApr * 100).toFixed(2)}%` : null,
    averageFundingRate: averageFundingRate ?? null,
    openInterest: market.openInterest || null,
    oraclePrice: market.oraclePrice,
    markPrice: market.markPrice ?? null,
    indexPrice: market.indexPrice ?? null,
    maxLeverage: market.maxLeverage ?? null,
    fundingIntervalHours: market.fundingIntervalHours ?? null,
    nextFundingTime: market.nextFundingTime ?? null,
    fundingStats: fundingStats ?? null,
  }
}

/**
 * Protocol config for funding stats computation.
 * hoursPerInterval: actual funding settlement period
 * recordingCadenceHours: how often entries are stored in DB
 * samplingStep: dedup step (hoursPerInterval / recordingCadenceHours)
 */
const PROTOCOL_FUNDING_CONFIG: Record<string, { hoursPerInterval: number; recordingCadenceHours: number }> = {
  '01':          { hoursPerInterval: 1, recordingCadenceHours: 1 },
  hyperliquid:   { hoursPerInterval: 1, recordingCadenceHours: 1 },
  pacifica:      { hoursPerInterval: 1, recordingCadenceHours: 1 },
  lighter:       { hoursPerInterval: 8, recordingCadenceHours: 1 }, // provider says 1 but rate is 8hr
  phoenix:       { hoursPerInterval: 1, recordingCadenceHours: 1 },
}

function computeFundingStats(
  liveRate: number,
  protocol: string,
  intervalHoursOverride: number | undefined, // for Aster: use per-symbol value from provider
  historyRates: number[], // newest first, already filtered to this symbol+protocol
): FundingStats {
  const config = PROTOCOL_FUNDING_CONFIG[protocol]
  const hoursPerInterval = intervalHoursOverride ?? config?.hoursPerInterval ?? 1
  const recordingCadenceHours = config?.recordingCadenceHours ?? hoursPerInterval
  const samplingStep = Math.max(1, Math.round(hoursPerInterval / recordingCadenceHours))

  // Deduplicate entries (needed for Lighter: same rate repeated each hour within 8hr window)
  const sampled = historyRates.filter((_, i) => i % samplingStep === 0)

  const entriesFor1hr  = Math.max(1, Math.round(1  / hoursPerInterval))
  const entriesFor8hr  = Math.max(1, Math.round(8  / hoursPerInterval))
  const entriesFor24hr = Math.max(1, Math.round(24 / hoursPerInterval))

  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0)

  const slice1hr  = sampled.slice(0, entriesFor1hr)
  const slice8hr  = sampled.slice(0, entriesFor8hr)
  const slice24hr = sampled.slice(0, entriesFor24hr)

  const hr1_bps   = slice1hr.length  > 0 ? (sum(slice1hr)  / (entriesFor1hr * hoursPerInterval)) * 10000 : liveRate * 10000
  const hr8_bps   = slice8hr.length  > 0 ? sum(slice8hr)   * 10000 : liveRate * 8 * 10000
  const daily_bps = slice24hr.length > 0 ? sum(slice24hr)  * 10000 : liveRate * 24 * 10000
  const yearly_apr_pct = sampled.length > 0
    ? (sum(sampled) / sampled.length) * (24 / hoursPerInterval) * 365 * 100
    : liveRate * (24 / hoursPerInterval) * 365 * 100

  return {
    interval: `${hoursPerInterval}hr`,
    raw_bps: liveRate * 10000,
    normalized: {
      label: sampled.length > 0 ? 'Normalized(72h)' : 'Normalized(live)',
      hr1_bps: parseFloat(hr1_bps.toFixed(4)),
      hr8_bps: parseFloat(hr8_bps.toFixed(4)),
      daily_bps: parseFloat(daily_bps.toFixed(4)),
      yearly_apr_pct: parseFloat(yearly_apr_pct.toFixed(4)),
    },
  }
}

/**
 * GET /api/arb/markets
 * Fetch market data across protocols
 * Public endpoint - no auth required
 */
export async function marketsHandler(c: Context) {
  try {
    // Use cached market data (refreshes every 30 seconds)
    const { asterMarkets, lighterMarkets, pacificaMarkets, hyperliquidMarkets, zoMarkets, phoenixMarkets, hip3Markets } = await getCachedMarketData()

    // Query 72h of funding rate history for stats computation
    const since = new Date(Date.now() - 72 * 60 * 60 * 1000)
    const historyRows = await db.select({
      symbol: fundingRateHistory.symbol,
      dex: fundingRateHistory.dex,
      rate: fundingRateHistory.rate,
    }).from(fundingRateHistory)
      .where(gte(fundingRateHistory.timestamp, since))
      .orderBy(desc(fundingRateHistory.timestamp))

    // Group into Map<`${symbol}:${dex}`, rate[]> (newest first)
    const historyMap = new Map<string, number[]>()
    for (const row of historyRows) {
      const key = `${row.symbol.toUpperCase()}:${row.dex}`
      const list = historyMap.get(key) ?? []
      list.push(row.rate)
      historyMap.set(key, list)
    }

    // Build symbol -> market data mapping
    const marketsMap = new Map<string, MarketResponse>()

    const emptyEntry = (symbol: string): MarketResponse => ({
      symbol,
      aster: null,
      lighter: null,
      pacifica: null,
      hyperliquid: null,
      '01': null,
      phoenix: null,
      maxArb: null,
      maxArbApr: null,
      longProtocol: null,
      shortProtocol: null,
    })

    const getHistory = (symbol: string, protocol: string) =>
      historyMap.get(`${symbol}:${protocol}`) ?? []

    // Add Aster markets (interval varies per symbol — pass fundingIntervalHours as override)
    for (const market of asterMarkets) {
      const symbol = market.symbol.toUpperCase()
      const entry = marketsMap.get(symbol) ?? emptyEntry(symbol)
      const stats = market.fundingRate != null
        ? computeFundingStats(market.fundingRate, 'aster', market.fundingIntervalHours, getHistory(symbol, 'aster'))
        : null
      entry.aster = toMarketData(market, undefined, stats)
      marketsMap.set(symbol, entry)
    }

    // Add Lighter markets
    for (const market of lighterMarkets) {
      const symbol = market.symbol.toUpperCase()
      const entry = marketsMap.get(symbol) ?? emptyEntry(symbol)
      const stats = market.fundingRate != null
        ? computeFundingStats(market.fundingRate, 'lighter', undefined, getHistory(symbol, 'lighter'))
        : null
      entry.lighter = toMarketData(market, undefined, stats)
      marketsMap.set(symbol, entry)
    }

    // Add Pacifica markets
    for (const market of pacificaMarkets) {
      const symbol = market.symbol.toUpperCase()
      const entry = marketsMap.get(symbol) ?? emptyEntry(symbol)
      const stats = market.fundingRate != null
        ? computeFundingStats(market.fundingRate, 'pacifica', undefined, getHistory(symbol, 'pacifica'))
        : null
      entry.pacifica = toMarketData(market, undefined, stats)
      marketsMap.set(symbol, entry)
    }

    // Add Hyperliquid markets
    for (const market of hyperliquidMarkets) {
      const symbol = market.symbol.toUpperCase()
      const entry = marketsMap.get(symbol) ?? emptyEntry(symbol)
      const stats = market.fundingRate != null
        ? computeFundingStats(market.fundingRate, 'hyperliquid', undefined, getHistory(symbol, 'hyperliquid'))
        : null
      entry.hyperliquid = toMarketData(market, undefined, stats)
      marketsMap.set(symbol, entry)
    }

    // Add 01 markets
    for (const market of zoMarkets) {
      const symbol = market.symbol.toUpperCase()
      const entry = marketsMap.get(symbol) ?? emptyEntry(symbol)
      const stats = market.fundingRate != null
        ? computeFundingStats(market.fundingRate, '01', undefined, getHistory(symbol, '01'))
        : null
      entry['01'] = toMarketData(market, undefined, stats)
      marketsMap.set(symbol, entry)
    }

    // Add Phoenix markets
    for (const market of phoenixMarkets) {
      const symbol = market.symbol.toUpperCase()
      const entry = marketsMap.get(symbol) ?? emptyEntry(symbol)
      const stats = market.fundingRate != null
        ? computeFundingStats(market.fundingRate, 'phoenix', undefined, getHistory(symbol, 'phoenix'))
        : null
      entry.phoenix = toMarketData(market, undefined, stats)
      marketsMap.set(symbol, entry)
    }

    // Add HIP-3 markets (one column per curated dex, keyed by `hl:<name>`).
    for (const [dexName, markets] of Object.entries(hip3Markets)) {
      const protocolId = getHip3ProtocolId(dexName as Hip3DexName)
      for (const market of markets) {
        const symbol = market.symbol.toUpperCase()
        const entry = marketsMap.get(symbol) ?? emptyEntry(symbol)
        const stats = market.fundingRate != null
          ? computeFundingStats(market.fundingRate, 'hyperliquid', undefined, getHistory(symbol, protocolId))
          : null
        entry[protocolId] = toMarketData(market, undefined, stats)
        marketsMap.set(symbol, entry)
      }
    }

    // Compute maxArb, longProtocol, shortProtocol per symbol.
    // Normalize all rates to 1hr before comparing:
    //   Aster: divide by fundingIntervalHours (per-symbol, varies 1/2/4/8)
    //   Lighter: divide by 8 (provider reports interval as 1 but rate is 8hr)
    //   All others: already 1hr, divide by 1
    const normalize1h = (rate: number, protocol: string, intervalHours: number | undefined): number => {
      if (protocol === 'lighter') return rate / 8
      return rate / (intervalHours ?? 1)
    }

    // Collect normalized rates per symbol across all protocols
    const ratesBySymbol = new Map<string, { protocol: string; normalizedRate: number }[]>()

    const addRates = (markets: any[], protocolId: string) => {
      for (const market of markets) {
        if (market.fundingRate == null) continue
        const symbol = market.symbol.toUpperCase()
        const normalized = normalize1h(market.fundingRate, protocolId, market.fundingIntervalHours)
        const list = ratesBySymbol.get(symbol) ?? []
        list.push({ protocol: protocolId, normalizedRate: normalized })
        ratesBySymbol.set(symbol, list)
      }
    }

    addRates(asterMarkets, 'aster')
    addRates(lighterMarkets, 'lighter')
    addRates(pacificaMarkets, 'pacifica')
    addRates(hyperliquidMarkets, 'hyperliquid')
    addRates(zoMarkets, '01')
    addRates(phoenixMarkets, 'phoenix')
    for (const [dexName, dexMarkets] of Object.entries(hip3Markets)) {
      addRates(dexMarkets, getHip3ProtocolId(dexName as Hip3DexName))
    }

    for (const [symbol, rates] of ratesBySymbol) {
      const entry = marketsMap.get(symbol)
      if (!entry || rates.length < 2) continue
      let highest = rates[0]
      let lowest = rates[0]
      for (const r of rates) {
        if (r.normalizedRate > highest.normalizedRate) highest = r
        if (r.normalizedRate < lowest.normalizedRate) lowest = r
      }
      const spread = highest.normalizedRate - lowest.normalizedRate
      entry.maxArb = `${(spread * 100).toFixed(5)}%`
      entry.maxArbApr = `${(spread * 24 * 365 * 100).toFixed(2)}%`
      entry.longProtocol = lowest.protocol
      entry.shortProtocol = highest.protocol
    }

    const markets = Array.from(marketsMap.values())

    return c.json({
      status: 'success',
      count: markets.length,
      markets,
    })
  } catch (error) {
    log.error('[arb/markets] Error:', error instanceof Error ? error.message : error)

    return c.json({
      status: 'error',
      message: 'Failed to fetch markets',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
