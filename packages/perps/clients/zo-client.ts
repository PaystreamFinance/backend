import { log } from '../logger'

export const ZO_MAINNET_BASE = 'https://zo-mainnet.n1.xyz'
export const ZO_DEVNET_BASE = 'https://zo-devnet.n1.xyz'

/** Default TTL for the shared /info cache — 10 min; /info is effectively static. */
export const ZO_INFO_CACHE_TTL_MS = 10 * 60 * 1000

/** Max bytes accepted by POST /action (SDK constant MAX_ENCODED_ACTION_SIZE). */
export const ZO_MAX_ACTION_BYTES = 1024

/** Engine rejects actions whose current_timestamp drifts >60s from server. */
export const ZO_TIMESTAMP_DRIFT_SEC = 60

/** Default session lifetime — 30 days, matching the SDK's SESSION_TTL. */
export const ZO_SESSION_TTL_SEC = 60 * 60 * 24 * 30

export interface ZoMarketSpec {
  marketId: number
  symbol: string          // e.g. "BTCUSD"
  priceDecimals: number
  sizeDecimals: number
  baseTokenId: number
  quoteTokenId: number
  imf: number             // Initial margin fraction (1/imf = max leverage)
  mmf: number             // Maintenance margin fraction
  cmf: number             // Close margin fraction
}

export interface ZoTokenSpec {
  tokenId: number
  symbol: string
  decimals: number
  mintAddr: string
  weightBps: number
}

export interface ZoInfoResponse {
  markets: ZoMarketSpec[]
  tokens: ZoTokenSpec[]
}

export interface ZoPerpStats {
  mark_price: number
  aggregated_funding_index: number
  funding_rate: number           // Hourly rate as decimal (e.g. -0.000023)
  next_funding_time: string      // ISO 8601 UTC
  open_interest: number          // Total OI in base asset units (not split by side)
}

export interface ZoMarketStats {
  indexPrice: number | null
  indexPriceConf?: number
  volumeBase24h: number
  volumeQuote24h: number
  high24h: number
  low24h: number
  close24h: number
  prevClose24h: number
  perpStats: ZoPerpStats | null
  frozen?: boolean
}

export interface ZoUserInfo {
  /** Nord account ids owned by this Solana pubkey. */
  accountIds: number[]
  /** Active sessions keyed by session id → { session_pubkey, expiry_timestamp }. */
  sessions?: Record<string, { session_pubkey?: string; expiry_timestamp?: number }>
}

/** Per-market perp position. Matches Nord's `PerpPositionUpdate` schema. */
export interface ZoPerpPositionUpdate {
  baseSize: number
  price: number               // avg entry price in USD
  updatedFundingRateIndex?: number
  fundingPaymentPnl?: number  // USD
  tradingPnl?: number         // USD
  sizePricePnl?: number       // USD — deprecated in favour of tradingPnl
  isLong: boolean
}

/** Per-market position summary. Matches Nord's `PositionSummary` schema. */
export interface ZoPositionSummary {
  marketId: number
  openOrders?: number
  perp?: ZoPerpPositionUpdate | null
  actionId?: number
}

export interface ZoAccountBalance {
  tokenId: number
  token?: string  // Convenience symbol (e.g. "USDC") alongside tokenId.
  amount: number  // Already USD/human-readable; NOT shifted by token decimals.
}

/**
 * Account-level margin snapshot. Per Nord docs: "Each field expressed in USD,
 * basis points per account. Value of 1.0000 means 1 USD." `imf`/`mmf`/etc. are
 * USD margin requirements; `pon`/`pn` are position notionals; the ratio
 * `mf/pon` is basis points (margin-to-notional).
 */
export interface ZoAccountMargins {
  omf: number           // USD, tokens + positive PnL − debt/negative PnL
  mf: number            // USD
  imf: number           // USD, initial margin requirement
  cmf: number           // USD, close-margin fraction (orders cancelled below this)
  mmf: number           // USD, maintenance margin
  pon: number           // USD, open position notional
  pn: number            // USD, position notional
  bankruptcy: boolean
}

export interface ZoAccountInfo {
  updateId?: number
  balances?: ZoAccountBalance[]
  positions?: ZoPositionSummary[]
  orders?: any[]
  margins?: ZoAccountMargins
}

export interface ZoDepositInfo {
  time: string              // RFC3339
  actionId: number
  accountId: number
  tokenId: number
  amount: number
  balance: number
  eventIndex: number
}

export interface ZoWithdrawalInfo {
  time: string              // RFC3339
  actionId: number
  accountId: number
  tokenId: number
  amount: number
  balance: number
  fee: number
  destPubkey?: string | null
}

export interface ZoPageResult<T> {
  items: T[]
  nextStartInclusive?: number | null
}

/** Fee tier config — fees quoted in ppm (parts per million). 100 ppm = 1 bps. */
export interface ZoFeeTierConfig {
  maker_fee_ppm: number
  taker_fee_ppm: number
}

/** Tuple returned by /fee/brackets/info — [tierId, config]. */
export type ZoFeeBracket = [number, ZoFeeTierConfig]

export interface ZoAccountFundingInfo {
  time: string          // RFC3339
  actionId: number
  marketId: number
  positionSize: number  // Signed: + long, - short
  fundingPnl: number    // USD paid TO the account (positive = earned, negative = paid)
}

/** `/account/{id}/history/funding` paginates with a string cursor. */
export interface ZoStringPageResult<T> {
  items: T[]
  nextStartInclusive?: string | null
}

export interface ZoClientOptions {
  baseUrl?: string
  timeoutMs?: number
}

export class ZoClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(options: ZoClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ZO_MAINNET_BASE
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  private async fetchWithTimeout(path: string, options?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Fetch timeout after ${this.timeoutMs}ms: ${url}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await this.fetchWithTimeout(path)
    if (!response.ok) {
      throw new Error(`01 API ${path} failed: ${response.status} ${response.statusText}`)
    }
    return response.json() as Promise<T>
  }

  /** Raw GET returning bytes — used by Receipt fetches that might stream binary. */
  private async fetchBytes(path: string, options?: RequestInit): Promise<Uint8Array> {
    const response = await this.fetchWithTimeout(path, options)
    const buf = new Uint8Array(await response.arrayBuffer())
    if (!response.ok) {
      const text = new TextDecoder().decode(buf)
      throw new Error(`01 API ${path} failed: ${response.status} ${text.slice(0, 200)}`)
    }
    return buf
  }

  /** GET /info — all markets + tokens with margin params and decimals */
  async getInfo(): Promise<ZoInfoResponse> {
    return this.fetchJson<ZoInfoResponse>('/info')
  }

  /**
   * Return a cached /info response (shared across all callers in the process)
   * or fetch-and-cache on first call / after TTL expiry. Single-flighted so
   * concurrent callers share a single in-flight request.
   */
  getInfoCached(ttlMs: number = ZO_INFO_CACHE_TTL_MS): Promise<ZoInfoResponse> {
    return getZoInfoCached(this, ttlMs)
  }

  /** GET /market/{id}/stats — per-market 24h stats + perpStats */
  async getMarketStats(marketId: number): Promise<ZoMarketStats> {
    return this.fetchJson<ZoMarketStats>(`/market/${marketId}/stats`)
  }

  /** GET /timestamp — engine server-time in unix seconds. */
  async getTimestamp(): Promise<bigint> {
    const res = await fetch(`${this.baseUrl}/timestamp`)
    if (!res.ok) throw new Error(`01 /timestamp failed: ${res.status}`)
    const text = (await res.text()).trim()
    return BigInt(text)
  }

  /** GET /user/{pubkey} — resolve a Solana pubkey to its Nord accountIds + sessions. */
  async getUserInfo(pubkey: string): Promise<ZoUserInfo | null> {
    try {
      return await this.fetchJson<ZoUserInfo>(`/user/${pubkey}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('404')) return null
      throw error
    }
  }

  /** GET /account/{id} — balances, positions, open orders, margin state. */
  async getAccount(accountId: number): Promise<ZoAccountInfo | null> {
    try {
      return await this.fetchJson<ZoAccountInfo>(`/account/${accountId}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('404')) return null
      throw error
    }
  }

  /** GET /account/{id}/triggers — pending TP/SL trigger orders for an account. */
  async getAccountTriggers(accountId: number): Promise<any[]> {
    try {
      const res = await this.fetchJson<any>(`/account/${accountId}/triggers`)
      if (Array.isArray(res)) return res
      if (Array.isArray(res?.items)) return res.items
      if (Array.isArray(res?.triggers)) return res.triggers
      return []
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('404')) return []
      throw error
    }
  }

  /**
   * POST /action — submit a signed protobuf Action envelope.
   * Body must be `len-prefix | Action bytes | 64-byte ed25519 sig` (≤1024 bytes total).
   * Returns raw length-delimited Receipt bytes for the caller to decode.
   */
  async submitAction(body: Uint8Array): Promise<Uint8Array> {
    if (body.length > ZO_MAX_ACTION_BYTES) {
      throw new Error(`01 action body too large: ${body.length} > ${ZO_MAX_ACTION_BYTES}`)
    }
    return this.fetchBytes('/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      // Cast to BodyInit — TS's RequestInit.body doesn't accept Uint8Array directly,
      // but fetch-at-runtime (Bun / Node 18+) handles it via ArrayBufferView.
      body: body as unknown as BodyInit,
    })
  }

  private getHistoryPage<T>(
    accountId: number,
    kind: 'deposit' | 'withdrawal',
    startInclusive?: number,
  ): Promise<ZoPageResult<T>> {
    const qs = startInclusive !== undefined ? `?startInclusive=${startInclusive}` : ''
    return this.fetchJson<ZoPageResult<T>>(`/account/${accountId}/history/${kind}${qs}`)
  }

  /** GET /account/{id}/history/deposit — paginated deposit history. */
  getDepositHistory(accountId: number, startInclusive?: number): Promise<ZoPageResult<ZoDepositInfo>> {
    return this.getHistoryPage<ZoDepositInfo>(accountId, 'deposit', startInclusive)
  }

  /** GET /account/{id}/history/withdrawal — paginated withdrawal history. */
  getWithdrawalHistory(accountId: number, startInclusive?: number): Promise<ZoPageResult<ZoWithdrawalInfo>> {
    return this.getHistoryPage<ZoWithdrawalInfo>(accountId, 'withdrawal', startInclusive)
  }

  /** GET /fee/brackets/info — all fee tier configs. */
  async getFeeBrackets(): Promise<ZoFeeBracket[]> {
    return this.fetchJson<ZoFeeBracket[]>('/fee/brackets/info')
  }

  /** GET /account/{id}/fee/tier — resolved tier id for an account. */
  async getAccountFeeTier(accountId: number): Promise<number | null> {
    try {
      return await this.fetchJson<number>(`/account/${accountId}/fee/tier`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('404')) return null
      throw error
    }
  }

  /**
   * GET /account/{id}/history/funding — paginated per-account funding payment
   * history. `since`/`until` are RFC3339 timestamps; `startInclusive` is the
   * string cursor from a prior call's `nextStartInclusive`.
   */
  async getFundingHistory(
    accountId: number,
    opts: { since?: string; until?: string; startInclusive?: string; pageSize?: number } = {},
  ): Promise<ZoStringPageResult<ZoAccountFundingInfo>> {
    const params = new URLSearchParams()
    if (opts.since) params.set('since', opts.since)
    if (opts.until) params.set('until', opts.until)
    if (opts.startInclusive) params.set('startInclusive', opts.startInclusive)
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
    const qs = params.size > 0 ? `?${params.toString()}` : ''
    return this.fetchJson<ZoStringPageResult<ZoAccountFundingInfo>>(`/account/${accountId}/history/funding${qs}`)
  }

  /** Fan out /market/{id}/stats across a list of market ids, returning only successful fetches. */
  async fetchAllMarketStats(
    marketIds: number[],
    concurrency = 8,
  ): Promise<Map<number, ZoMarketStats>> {
    const results = new Map<number, ZoMarketStats>()

    const queue = [...marketIds]
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const id = queue.shift()
        if (id === undefined) break
        try {
          const stats = await this.getMarketStats(id)
          results.set(id, stats)
        } catch (error) {
          log.warn(`[zo-client] Failed to fetch stats for marketId=${id}:`, error)
        }
      }
    })

    await Promise.all(workers)
    return results
  }
}

export function createZoClient(options: ZoClientOptions = {}): ZoClient {
  return new ZoClient(options)
}

/** Process-global single-flight cache for 01's /info. */

interface CachedInfo {
  at: number
  info: ZoInfoResponse
}

let sharedInfoCache: CachedInfo | null = null
let inflightInfo: Promise<ZoInfoResponse> | null = null

async function getZoInfoCached(client: ZoClient, ttlMs: number): Promise<ZoInfoResponse> {
  const fresh = sharedInfoCache && Date.now() - sharedInfoCache.at < ttlMs
  if (fresh) return sharedInfoCache!.info
  if (inflightInfo) return inflightInfo
  inflightInfo = client.getInfo()
    .then(info => {
      sharedInfoCache = { at: Date.now(), info }
      return info
    })
    .finally(() => { inflightInfo = null })
  return inflightInfo
}

/** Clear the shared /info cache. Useful in tests or after a markets change webhook. */
export function clearZoInfoCache(): void {
  sharedInfoCache = null
}

// WeakMap keyed on the cached ZoInfoResponse so derived data (symbol maps,
// per-poll arrays) is only rebuilt when /info itself is refreshed.
const derivedByInfo = new WeakMap<ZoInfoResponse, Map<string, unknown>>()

/**
 * Return a value derived from /info, computed once per cached info object
 * and reused until the cache refreshes. `key` names the derivation so
 * multiple independent derivations can coexist on the same info.
 */
export async function getZoInfoDerived<T>(
  client: ZoClient,
  key: string,
  build: (info: ZoInfoResponse) => T,
  ttlMs: number = ZO_INFO_CACHE_TTL_MS,
): Promise<T> {
  const info = await client.getInfoCached(ttlMs)
  let slot = derivedByInfo.get(info)
  if (!slot) {
    slot = new Map()
    derivedByInfo.set(info, slot)
  }
  if (!slot.has(key)) slot.set(key, build(info))
  return slot.get(key) as T
}
