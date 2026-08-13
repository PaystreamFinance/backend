import { log } from './logger'
import { parseHip3ProtocolId, stripHip3Prefix, type Hip3DexName } from './hip3/dex-config'
import { getCachedMarketData } from './registry'

let priceCache: Map<string, number> = new Map()
let priceCacheTimestamp = 0
const PRICE_CACHE_TTL_MS = 5_000

// One entry per HIP-3 dex — symbols on different dexes share names, so cache
// per-dex rather than merging into the shared map.
interface Hip3DexCache {
  prices: Map<string, number>
  timestamp: number
}
const hip3PriceCache = new Map<Hip3DexName, Hip3DexCache>()
const hip3FetchInFlight = new Map<Hip3DexName, Promise<Hip3DexCache | null>>()

/**
 * Fetch current oracle price for a symbol.
 * Queries public APIs directly — no backend dependency.
 * Tries Hyperliquid first (broadest coverage), then Pacifica.
 */
export async function fetchCurrentPrice(symbol: string, protocol?: string): Promise<number | null> {
  const upper = symbol.toUpperCase()

  // If the caller pins a HIP-3 dex, fetch from that dex first — symbols on
  // HIP-3 dexes don't exist on vanilla HL and wouldn't appear in the shared cache.
  const hip3Dex = protocol ? parseHip3ProtocolId(protocol) : null
  if (hip3Dex) {
    const price = await fetchHip3Price(hip3Dex, upper)
    if (price !== null) return price
  }

  // Check cache first
  const now = Date.now()
  if (now - priceCacheTimestamp < PRICE_CACHE_TTL_MS && priceCache.has(upper)) {
    return priceCache.get(upper) || null
  }

  // Fetch from all sources in parallel, merge results
  const results = await Promise.allSettled([
    fetchHyperliquidPrices(),
    fetchPacificaPrices(),
    fetchAsterPrices(),
    fetchLighterPrices(),
    fetchPhoenixPrices(),
  ])

  // Merge into cache (first source wins for each symbol)
  const newCache = new Map<string, number>()

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      for (const [sym, price] of result.value) {
        if (!newCache.has(sym)) {
          newCache.set(sym, price)
        }
      }
    }
  }

  if (newCache.size > 0) {
    priceCache = newCache
    priceCacheTimestamp = now
  }

  // Direct match
  if (priceCache.has(upper)) {
    return priceCache.get(upper)!
  }

  // Handle Pacifica k-prefix: "BONK" -> look for "KBONK"
  if (priceCache.has('K' + upper)) {
    return priceCache.get('K' + upper)!
  }

  return null
}

/**
 * HIP-3 price lookup via `allMids` scoped to the dex. Mids are keyed by
 * prefixed coin name (e.g. `xyz:XYZ100`); we strip the prefix to match the
 * symbol the caller passed. Concurrent callers for the same dex share one
 * in-flight fetch.
 */
async function fetchHip3Price(dexName: Hip3DexName, upperSymbol: string): Promise<number | null> {
  const now = Date.now()
  const cached = hip3PriceCache.get(dexName)
  if (cached && now - cached.timestamp < PRICE_CACHE_TTL_MS) {
    return cached.prices.get(upperSymbol) ?? null
  }

  let inflight = hip3FetchInFlight.get(dexName)
  if (!inflight) {
    inflight = refreshHip3Prices(dexName)
    hip3FetchInFlight.set(dexName, inflight)
    inflight.finally(() => hip3FetchInFlight.delete(dexName))
  }

  const refreshed = await inflight
  return refreshed?.prices.get(upperSymbol) ?? null
}

async function refreshHip3Prices(dexName: Hip3DexName): Promise<Hip3DexCache | null> {
  try {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids', dex: dexName }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null

    const mids = await response.json() as Record<string, string>
    const prices = new Map<string, number>()
    for (const [coin, priceStr] of Object.entries(mids)) {
      const stripped = stripHip3Prefix(dexName, coin).toUpperCase()
      const price = parseFloat(priceStr)
      if (price > 0) prices.set(stripped, price)
    }
    const entry: Hip3DexCache = { prices, timestamp: Date.now() }
    hip3PriceCache.set(dexName, entry)
    return entry
  } catch (e) {
    log.warn(`[arb-market-data] HIP-3 ${dexName} price fetch failed:`, e)
    return null
  }
}

/**
 * Hyperliquid public API — metaAndAssetCtxs (no auth)
 */
async function fetchHyperliquidPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  try {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: AbortSignal.timeout(10_000),
    })

    if (response.ok) {
      const [meta, assetCtxs] = await response.json() as [
        { universe: { name: string }[] },
        { oraclePx?: string }[]
      ]

      for (let i = 0; i < meta.universe.length; i++) {
        const name = meta.universe[i].name.toUpperCase()
        const oraclePx = assetCtxs[i]?.oraclePx
        if (oraclePx) {
          prices.set(name, parseFloat(oraclePx))
        }
      }
    }
  } catch (e) {
    log.warn('[arb-market-data] Hyperliquid price fetch failed:', e)
  }
  return prices
}

/**
 * Pacifica public API — /api/v1/prices (no auth)
 */
async function fetchPacificaPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  try {
    const pacificaApi = process.env.PACIFICA_API_BASE || 'https://api.pacifica.fi'
    const response = await fetch(`${pacificaApi}/api/v1/prices`, {
      signal: AbortSignal.timeout(10_000),
    })

    if (response.ok) {
      const data = await response.json() as { success?: boolean; data?: Record<string, { oracle?: string; mark?: string }> }
      if (data.success && data.data) {
        for (const [sym, priceData] of Object.entries(data.data)) {
          const price = priceData.oracle ? parseFloat(priceData.oracle) : (priceData.mark ? parseFloat(priceData.mark) : null)
          if (price) {
            prices.set(sym.toUpperCase(), price)
          }
        }
      }
    }
  } catch (e) {
    log.warn('[arb-market-data] Pacifica price fetch failed:', e)
  }
  return prices
}

/**
 * Aster public API — /fapi/v3/premiumIndex (no auth)
 * Returns mark prices for all perpetual markets.
 */
async function fetchAsterPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  try {
    const response = await fetch('https://fapi.asterdex.com/fapi/v3/premiumIndex', {
      signal: AbortSignal.timeout(10_000),
    })

    if (response.ok) {
      const data = await response.json() as Array<{ symbol: string; markPrice: string }>
      for (const entry of data) {
        const markPrice = parseFloat(entry.markPrice)
        if (markPrice > 0) {
          // Strip USDT suffix to get base symbol
          const base = entry.symbol.replace(/USDT$/, '').toUpperCase()
          if (!prices.has(base)) {
            prices.set(base, markPrice)
          }
        }
      }
    }
  } catch (e) {
    log.warn('[arb-market-data] Aster price fetch failed:', e)
  }
  return prices
}

/**
 * Lighter public API — /api/v1/orderBookDetails (no auth)
 * Uses last_trade_price from order book details as price source.
 */
async function fetchLighterPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  try {
    const response = await fetch('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails', {
      signal: AbortSignal.timeout(10_000),
    })

    if (response.ok) {
      const data = await response.json() as { order_book_details: Array<{ symbol: string; market_type: string; last_trade_price: number }> }
      for (const detail of data.order_book_details || []) {
        if (detail.market_type !== 'perp') continue
        const price = detail.last_trade_price
        if (price > 0) {
          const sym = detail.symbol.toUpperCase()
          if (!prices.has(sym)) {
            prices.set(sym, price)
          }
        }
      }
    }
  } catch (e) {
    log.warn('[arb-market-data] Lighter price fetch failed:', e)
  }
  return prices
}

/**
 * Phoenix prices — read from the shared cached registry rather than hitting
 * the API directly. The registry already refreshes every 30s and populates
 * `markPrice` on each ArbMarketInfo via the funding overview.
 */
async function fetchPhoenixPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  try {
    const { phoenixMarkets } = await getCachedMarketData()
    for (const market of phoenixMarkets) {
      const sym = String(market.symbol || '').toUpperCase()
      const price = typeof market.markPrice === 'number' ? market.markPrice : 0
      if (sym && price > 0 && !prices.has(sym)) {
        prices.set(sym, price)
      }
    }
  } catch (e) {
    log.warn('[arb-market-data] Phoenix price fetch failed:', e)
  }
  return prices
}
