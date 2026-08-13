import type { FundingRateRecord } from '../types'
import { withRetry, canonicalizeSymbol, sleep, hoursAgo } from '../utils'
import { log } from '../../logger'
import { HIP3_DEX_NAMES, getHip3ProtocolId, stripHip3Prefix, type Hip3DexName } from '../../hip3/dex-config'

const HL_API = 'https://api.hyperliquid.xyz/info'
const REQUEST_DELAY_MS = 1000

interface HLFundingRecord {
  coin: string
  fundingRate: string
  premium: string
  time: number
}

interface HLMetaAsset {
  name: string
  szDecimals: number
}

// Per-dex universe cache. Key "" = main USDC perp; HIP-3 dexes use their name (e.g. "xyz").
const metaCache: Map<string, { universe: HLMetaAsset[]; ts: number }> = new Map()
const META_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

async function getMeta(dex: string = ''): Promise<HLMetaAsset[]> {
  const cached = metaCache.get(dex)
  if (cached && (Date.now() - cached.ts) < META_CACHE_TTL_MS) return cached.universe

  const body: Record<string, unknown> = { type: 'meta' }
  if (dex) body.dex = dex

  const data = await withRetry(
    async () => {
      const res = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HL meta ${dex ? `(${dex}) ` : ''}${res.status}`)
      return res.json() as Promise<{ universe: HLMetaAsset[] }>
    },
    `Hyperliquid meta${dex ? ` ${dex}` : ''}`,
  )

  metaCache.set(dex, { universe: data.universe, ts: Date.now() })
  return data.universe
}

function toCanonical(native: string): string {
  const upper = native.toUpperCase()
  return native.startsWith('k') && native.length > 1 ? canonicalizeSymbol(upper) : upper
}

export async function discoverSymbols(): Promise<{ canonical: string; native: string }[]> {
  try {
    const universe = await getMeta()
    return universe.map(asset => ({ canonical: toCanonical(asset.name), native: asset.name }))
  } catch (err) {
    log.error('[hl] Symbol discovery failed:', err)
    return []
  }
}

/**
 * Discover HIP-3 symbols across all curated builder-deployed dexes.
 *
 * HL's `meta?dex=<name>` returns assets whose `name` is already the prefixed
 * coin (e.g. `xyz:XYZ100`), which is the identifier the `fundingHistory`
 * endpoint expects. We strip the prefix to derive the native/canonical symbol.
 */
export async function discoverHip3Symbols(): Promise<
  { dexName: Hip3DexName; canonical: string; native: string; prefixedCoin: string }[]
> {
  const out: { dexName: Hip3DexName; canonical: string; native: string; prefixedCoin: string }[] = []
  for (const dexName of HIP3_DEX_NAMES) {
    try {
      const universe = await getMeta(dexName)
      for (const asset of universe) {
        const prefixedCoin = asset.name
        const native = stripHip3Prefix(dexName, prefixedCoin)
        out.push({
          dexName,
          canonical: toCanonical(native),
          native,
          prefixedCoin,
        })
      }
    } catch (err) {
      log.error(`[hl:${dexName}] Symbol discovery failed:`, err)
    }
  }
  return out
}

export async function fetchHistoricalRates(
  since: Date | null,
  symbols?: string[],
): Promise<FundingRateRecord[]> {
  const allRecords: FundingRateRecord[] = []

  const universe = await getMeta()
  const nativeMap = new Map<string, string>()
  for (const asset of universe) {
    nativeMap.set(toCanonical(asset.name), asset.name)
  }

  const targetSymbols = symbols && symbols.length > 0
    ? symbols.filter(s => nativeMap.has(s.toUpperCase()))
    : Array.from(nativeMap.keys())

  const startTime = (since ?? hoursAgo(72)).getTime()

  let consecutiveFailures = 0

  for (const symbol of targetSymbols) {
    const nativeCoin = nativeMap.get(symbol.toUpperCase())
    if (!nativeCoin) continue

    try {
      const records = await fetchFundingHistory(nativeCoin, startTime)
      consecutiveFailures = 0

      const canonical = nativeCoin.startsWith('k') && nativeCoin.length > 1
        ? '1000' + nativeCoin.slice(1).toUpperCase()
        : symbol.toUpperCase()

      for (const rec of records) {
        allRecords.push({
          dex: 'hyperliquid',
          symbol: canonical,
          protocolSymbol: nativeCoin,
          timestamp: new Date(rec.time),
          rate: parseFloat(rec.fundingRate),
          granularity: '1h',
        })
      }
    } catch (err) {
      consecutiveFailures++
      const msg = err instanceof Error ? err.message : String(err)

      if (msg.includes('429')) {
        log.warn(`[hl] Rate limited, backing off 10s...`)
        await sleep(10_000)
      } else {
        log.error(`[hl] Fetch error for ${nativeCoin}:`, err)
      }

      if (consecutiveFailures >= 10) {
        log.error(`[hl] ${consecutiveFailures} consecutive failures, aborting`)
        break
      }
    }

    await sleep(REQUEST_DELAY_MS)
  }

  // HIP-3 dexes — funding history is per-prefixed-coin (e.g. "xyz:XYZ100").
  // NOTE: this adds ~dozens of extra requests per curated dex; we rely on the
  // existing 1s delay + 429 backoff to stay within HL's rate budget.
  const hip3Records = await fetchHip3HistoricalRates(since)
  allRecords.push(...hip3Records)

  log.info(`[hl] ${allRecords.length} records from ${targetSymbols.length} main symbols + ${HIP3_DEX_NAMES.length} HIP-3 dexes`)
  return allRecords
}

/**
 * Fetch historical funding rates for every coin on every curated HIP-3 dex.
 * Records are emitted with `dex: "hl:<name>"` and `protocolSymbol: "<name>:<native>"`.
 */
export async function fetchHip3HistoricalRates(since: Date | null): Promise<FundingRateRecord[]> {
  const out: FundingRateRecord[] = []

  const startTime = (since ?? hoursAgo(72)).getTime()

  for (const dexName of HIP3_DEX_NAMES) {
    let universe: HLMetaAsset[]
    try {
      universe = await getMeta(dexName)
    } catch (err) {
      log.error(`[hl:${dexName}] meta fetch failed:`, err)
      continue
    }

    const protocolId = getHip3ProtocolId(dexName)
    let consecutiveFailures = 0
    let count = 0

    for (const asset of universe) {
      const prefixedCoin = asset.name
      const nativeCoin = stripHip3Prefix(dexName, prefixedCoin)
      const canonical = toCanonical(nativeCoin)

      try {
        const records = await fetchFundingHistory(prefixedCoin, startTime)
        consecutiveFailures = 0

        for (const rec of records) {
          out.push({
            dex: protocolId,
            symbol: canonical,
            protocolSymbol: prefixedCoin,
            timestamp: new Date(rec.time),
            rate: parseFloat(rec.fundingRate),
            granularity: '1h',
          })
        }
        count += records.length
      } catch (err) {
        consecutiveFailures++
        const msg = err instanceof Error ? err.message : String(err)

        if (msg.includes('429')) {
          log.warn(`[hl:${dexName}] Rate limited, backing off 10s...`)
          await sleep(10_000)
        } else {
          log.error(`[hl:${dexName}] Fetch error for ${prefixedCoin}:`, err)
        }

        if (consecutiveFailures >= 10) {
          log.error(`[hl:${dexName}] ${consecutiveFailures} consecutive failures, skipping rest of dex`)
          break
        }
      }

      await sleep(REQUEST_DELAY_MS)
    }

    log.info(`[hl:${dexName}] ${count} records from ${universe.length} symbols`)
  }

  return out
}

// HL caps fundingHistory at 500 records per call; paginate by advancing startTime.
const HL_PAGE_LIMIT = 500
const HL_MAX_PAGES = 3

async function fetchFundingHistory(
  coin: string,
  startTime: number,
): Promise<HLFundingRecord[]> {
  const all: HLFundingRecord[] = []
  let cursor = startTime

  for (let page = 0; page < HL_MAX_PAGES; page++) {
    const res = await fetch(HL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fundingHistory',
        coin,
        startTime: cursor,
      }),
    })

    if (res.status === 429) throw new Error(`HL fundingHistory 429`)
    if (!res.ok) throw new Error(`HL fundingHistory ${res.status}`)

    const records = await res.json() as HLFundingRecord[]
    if (!Array.isArray(records) || records.length === 0) break

    all.push(...records)

    if (records.length < HL_PAGE_LIMIT) break
    const lastTime = records[records.length - 1].time
    if (lastTime <= cursor) break
    cursor = lastTime + 1

    await sleep(REQUEST_DELAY_MS)
  }

  return all
}
