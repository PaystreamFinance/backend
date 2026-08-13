import type { PublicKey } from '@solana/web3.js'
import type {
  IArbProvider,
  ArbMarketInfo,
  ArbFeeInfo,
  OpenPositionParams,
  OpenPositionResult,
  ClosePositionResult,
  ArbPosition,
  FundingPayment,
  FundingPaymentsResult,
} from '../types'
import { ZoClient, createZoClient, ZO_TIMESTAMP_DRIFT_SEC, type ZoMarketSpec, type ZoMarketStats } from '../clients/zo-client'
import {
  loadZoSchema,
  encodeAction,
  decodeReceipt,
  packEnvelope,
  sessionSign,
  toScaledU64,
  type ZoProtoTypes,
} from '../clients/zo-codec'
import { canonicalizeSymbol } from '../funding-rates/utils'
import { log } from '../logger'

/**
 * Convert a canonical Paystream symbol (e.g. "BTC") to 01's format ("BTCUSD").
 * Also accepts already-suffixed symbols ("BTCUSD") as a passthrough.
 */
export function normalizeZoSymbol(symbol: string): string {
  const upper = symbol.toUpperCase()
  return upper.endsWith('USD') ? upper : `${upper}USD`
}

/** Strip 01's "USD" quote suffix → canonical Paystream symbol. */
export function baseFromZoSymbol(zoSymbol: string): string {
  const upper = zoSymbol.toUpperCase()
  const base = upper.endsWith('USD') ? upper.slice(0, -'USD'.length) : upper
  return canonicalizeSymbol(base)
}

/** Active session state held by the provider for signed actions. */
export interface ZoSessionCreds {
  sessionId: bigint          // uint64 assigned by Nord
  sessionSecretKey: Uint8Array // 64 bytes (nacl format)
  accountId: number          // Nord account id owning the session
  expiryTimestamp: bigint    // unix seconds
}

/** Minimal shape exposed via getClient() for callers that need raw REST. */
export interface ZoClientAccessor {
  getTimestamp(): Promise<bigint>
  getUserInfo(pubkey: string): ReturnType<ZoClient['getUserInfo']>
}

// Proto enum values — mirrored from zo-schema.proto so the encoder sees ints
// but our code reads as named constants.
const SIDE_ASK = 0
const SIDE_BID = 1
const TRIGGER_STOP_LOSS = 0
const TRIGGER_TAKE_PROFIT = 1
const INTENT_DECREASE = 0
const FILL_MODE_IOC = 2

/**
 * 01 Exchange (Nord / zo) perpetuals provider.
 *
 * Market data uses unauthenticated REST (`/info`, `/market/{id}/stats`).
 * Trading goes through the signed `POST /action` protobuf flow:
 *   - `CreateSession` is user-signed via Privy (ed25519 of hex(raw)), handled
 *     outside the provider (see api/clients/arb/zo-auth.ts). That flow produces
 *     a `ZoSessionCreds` which is then handed to `setSession()`.
 *   - `PlaceOrder` / `CancelOrder` are session-signed (raw ed25519) using the
 *     stored session key — fast, no Privy round-trip per order.
 */
export class ZoArbProvider implements IArbProvider {
  name = '01'

  private client: ZoClient
  private isInitialized = false
  /** marketId → spec from /info (decimals, imf, symbol) */
  private specsById: Map<number, ZoMarketSpec> = new Map()
  /** canonical base symbol (e.g. "BTC") → marketId */
  private idBySymbol: Map<string, number> = new Map()
  /** Protobuf types, loaded lazily once per process. */
  private proto: ZoProtoTypes | null = null
  /** Active session creds (null until setSession is called). */
  private session: ZoSessionCreds | null = null
  /** Owning Solana wallet — set via constructor for trading-capable instances. */
  private walletPubkey: PublicKey | null = null

  constructor(options: { baseUrl?: string; walletPubkey?: PublicKey } = {}) {
    this.client = createZoClient({ baseUrl: options.baseUrl })
    this.walletPubkey = options.walletPubkey ?? null
  }

  /** Access the underlying REST client (for auth flows that need /timestamp, /user, etc.). */
  getClient(): ZoClient {
    return this.client
  }

  /** Install session credentials after a successful CreateSession flow. */
  setSession(creds: ZoSessionCreds): void {
    this.session = creds
  }

  /** Clear the session state (e.g. on rotation). */
  clearSession(): void {
    this.session = null
  }

  hasSession(): boolean {
    return this.session !== null
  }

  /** Returns the cached market spec for a canonical symbol, or null. */
  getMarketSpec(symbol: string): ZoMarketSpec | null {
    const canonical = canonicalizeSymbol(symbol.toUpperCase())
    const id = this.idBySymbol.get(canonical)
    if (id === undefined) return null
    return this.specsById.get(id) ?? null
  }

  /** Step size for a market (1 / 10^sizeDecimals). */
  getLotSize(symbol: string): number {
    const spec = this.getMarketSpec(symbol)
    if (!spec) return 0.01
    return Math.pow(10, -spec.sizeDecimals)
  }

  /** Round-integer max leverage from imf (1 / imf). */
  getMaxLeverage(symbol: string): number {
    const spec = this.getMarketSpec(symbol)
    if (!spec || spec.imf <= 0) return 50
    return Math.round(1 / spec.imf)
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return

    try {
      const info = await this.client.getInfoCached()

      for (const market of info.markets) {
        this.specsById.set(market.marketId, market)
        this.idBySymbol.set(baseFromZoSymbol(market.symbol), market.marketId)
      }

      this.isInitialized = true
      log.info(`[zo-arb] Provider initialized with ${this.specsById.size} markets`)
    } catch (error) {
      log.error('[zo-arb] Failed to initialize:', error)
      throw error
    }
  }

  async getMarketInfo(symbol: string): Promise<ArbMarketInfo | null> {
    if (!this.isInitialized) {
      throw new Error('01 provider not initialized')
    }

    const canonical = canonicalizeSymbol(symbol.toUpperCase())
    const marketId = this.idBySymbol.get(canonical)
    if (marketId === undefined) return null

    const spec = this.specsById.get(marketId)
    if (!spec) return null

    try {
      const stats = await this.client.getMarketStats(marketId)
      return this.toArbMarketInfo(spec, stats)
    } catch (error) {
      log.warn(`[zo-arb] getMarketInfo(${symbol}) failed:`, error)
      return null
    }
  }

  async getAllMarkets(): Promise<ArbMarketInfo[]> {
    if (!this.isInitialized) {
      throw new Error('01 provider not initialized')
    }

    const marketIds = Array.from(this.specsById.keys())
    const statsById = await this.client.fetchAllMarketStats(marketIds)

    const markets: ArbMarketInfo[] = []
    for (const [marketId, spec] of this.specsById) {
      const stats = statsById.get(marketId)
      if (!stats) continue
      const info = this.toArbMarketInfo(spec, stats)
      if (info) markets.push(info)
    }
    return markets
  }

  async getFees(_symbol: string): Promise<ArbFeeInfo> {
    // 01 publishes per-account fee tiers via /account/{id}/fee/tier — for the
    // public markets endpoint we surface the public default tier. Tier 0 on
    // mainnet as of 2026-04-17 is 5 bps taker / 2 bps maker; refine once the
    // authed per-user read lands.
    return {
      takerFeeBps: 5,
      makerFeeBps: 2,
    }
  }

  /**
   * 01 uses a REST /action endpoint rather than on-chain Solana transactions.
   * IArbProvider requires this method, so we return an empty Transaction
   * placeholder and expect callers to use `executeTrade()` for the real flow
   * (matches the Pacifica provider's convention).
   */
  async buildOpenPositionTransaction(
    _params: OpenPositionParams,
    _wallet: PublicKey,
  ): Promise<OpenPositionResult> {
    throw new Error('01 uses executeTrade(), not buildOpenPositionTransaction')
  }

  async buildClosePositionTransaction(
    _symbol: string,
    _direction: 'long' | 'short',
    _wallet: PublicKey,
  ): Promise<ClosePositionResult> {
    throw new Error('01 uses executeClose(), not buildClosePositionTransaction')
  }

  /**
   * Place a market order via /action.
   *
   * Requires `setSession()` to have been called first. Uses `fill_mode =
   * IMMEDIATE_OR_CANCEL` with `price=0` and `size` scaled to market decimals
   * — the engine treats price=0 as "market" on IOC mode.
   */
  async executeTrade(params: OpenPositionParams & { reduceOnly?: boolean }): Promise<{ orderId: number; success: boolean }> {
    if (!this.isInitialized) throw new Error('01 provider not initialized')
    if (!this.session) throw new Error('01 session not set — call setSession() after creating a session')

    const spec = this.getMarketSpec(params.symbol)
    if (!spec) throw new Error(`01 market not found: ${params.symbol}`)

    const stats = await this.client.getMarketStats(spec.marketId)
    if (!stats.perpStats || !stats.indexPrice) {
      throw new Error(`01 market ${params.symbol} has no live stats`)
    }
    const refPrice = stats.indexPrice ?? stats.perpStats.mark_price

    // Size calculation — prefer explicit sizeAsset, else notionalUsd / refPrice.
    const notionalUsd = params.marginUsd * params.leverage
    const rawSize = params.sizeAsset ?? (notionalUsd / refPrice)
    const step = this.getLotSize(params.symbol)
    const roundedSize = Math.floor(rawSize / step) * step
    if (roundedSize < step) {
      throw new Error(`01 order too small: need ≥ ${step} ${params.symbol}`)
    }

    const proto = await this.loadProto()
    const timestamp = await this.freshTimestamp()
    const placeOrder: Record<string, any> = {
      sessionId: this.session.sessionId,
      marketId: spec.marketId,
      side: params.direction === 'long' ? SIDE_BID : SIDE_ASK,
      fillMode: FILL_MODE_IOC,
      isReduceOnly: params.reduceOnly ?? false,
      price: 0n, // 0 = unset → engine crosses book
      size: toScaledU64(roundedSize, spec.sizeDecimals),
      senderAccountId: this.session.accountId,
    }

    const raw = encodeAction(proto, {
      currentTimestamp: timestamp,
      placeOrder,
    })
    const signature = sessionSign(raw, this.session.sessionSecretKey)
    const envelope = packEnvelope(raw, signature)

    log.info(`[zo-arb] PlaceOrder ${params.direction.toUpperCase()} size=${roundedSize} ${params.symbol} marketId=${spec.marketId} sessionId=${this.session.sessionId}`)

    const receiptBytes = await this.client.submitAction(envelope)
    const receipt = decodeReceipt(proto, receiptBytes)
    return this.parseReceiptForOrder(receipt)
  }

  /**
   * Attach a take-profit trigger to an open position in the given market.
   * Engine executes as a reduce-only close at the trigger price; size is
   * unset so the engine applies max reduce size.
   */
  async setTakeProfit(symbol: string, triggerPrice: number): Promise<{ success: boolean; direction: 'long' | 'short' }> {
    return this.addTrigger(TRIGGER_TAKE_PROFIT, symbol, triggerPrice)
  }

  /** Attach a stop-loss trigger to an open position in the given market. */
  async setStopLoss(symbol: string, triggerPrice: number): Promise<{ success: boolean; direction: 'long' | 'short' }> {
    return this.addTrigger(TRIGGER_STOP_LOSS, symbol, triggerPrice)
  }

  private async addTrigger(
    kind: typeof TRIGGER_TAKE_PROFIT | typeof TRIGGER_STOP_LOSS,
    symbol: string,
    triggerPrice: number,
  ): Promise<{ success: boolean; direction: 'long' | 'short' }> {
    if (!this.isInitialized) throw new Error('01 provider not initialized')
    if (!this.session) throw new Error('01 session not set — call setSession() first')
    if (!this.walletPubkey) throw new Error('01 walletPubkey not set on provider')

    const spec = this.getMarketSpec(symbol)
    if (!spec) throw new Error(`01 market not found: ${symbol}`)

    const direction = await this.resolvePositionDirection(spec.marketId)
    const proto = await this.loadProto()
    const timestamp = await this.freshTimestamp()
    const side = direction === 'long' ? SIDE_ASK : SIDE_BID

    const raw = encodeAction(proto, {
      currentTimestamp: timestamp,
      addTrigger: {
        sessionId: this.session.sessionId,
        trigger: {
          key: { kind, side },
          triggerPrice: toScaledU64(triggerPrice, spec.priceDecimals),
          marketId: spec.marketId,
        },
        intent: INTENT_DECREASE,
        accountId: this.session.accountId,
      },
    })
    const signature = sessionSign(raw, this.session.sessionSecretKey)
    const envelope = packEnvelope(raw, signature)

    log.info(`[zo-arb] AddTrigger kind=${kind} ${symbol} @ ${triggerPrice} (direction=${direction})`)

    const receiptBytes = await this.client.submitAction(envelope)
    const receipt = decodeReceipt(proto, receiptBytes)
    if (receipt?.err) {
      throw new Error(`01 AddTrigger rejected: ${JSON.stringify(receipt.err)}`)
    }

    return { success: true, direction }
  }

  /**
   * Lean variant of `getPositions()` that reads /account/{id} directly via
   * the cached session's accountId and returns just the direction of one
   * market's position — no /user round-trip, no per-position stats enrichment.
   */
  private async resolvePositionDirection(marketId: number): Promise<'long' | 'short'> {
    if (!this.session) throw new Error('01 session not set — call setSession() first')
    const account = await this.client.getAccount(this.session.accountId)
    const pos = account?.positions?.find(p => p.marketId === marketId)
    if (!pos?.perp) throw new Error(`No 01 position for marketId=${marketId}`)
    if (!Number.isFinite(pos.perp.baseSize) || pos.perp.baseSize === 0) {
      throw new Error(`01 position for marketId=${marketId} has zero size`)
    }
    return pos.perp.isLong ? 'long' : 'short'
  }

  /** Close an open 01 position for the given symbol/direction via reduce-only market order. */
  async executeClose(symbol: string, direction: 'long' | 'short', wallet: PublicKey): Promise<{ orderId: number; success: boolean }> {
    const positions = await this.getPositions(wallet)
    const position = positions.find(p => p.symbol === canonicalizeSymbol(symbol.toUpperCase()) && p.direction === direction)
    if (!position) throw new Error(`01: no ${direction} position for ${symbol}`)

    return this.executeTrade({
      symbol,
      marginUsd: 0,
      leverage: 1,
      direction: direction === 'long' ? 'short' : 'long', // flip to close
      sizeAsset: position.sizeAsset,
      reduceOnly: true,
    })
  }

  /**
   * Max notional (USD) the 01 engine will let this wallet open on `symbol`,
   * per Nord's "Max Available to Trade" formula:
   *   `max_notional = (omf − imf) / IMF_base_market`
   *
   * `omf` = own margin fund (collateral + unrealized PnL − debt), `imf` = USD
   * initial-margin requirement already booked by existing positions, both read
   * from `GET /account/{id}`; `IMF_base_market` is the per-market fraction from
   * `GET /info` (`spec.imf`, where 1/imf = max leverage, e.g. 0.02 → 50x).
   *
   * Returns `null` when the wallet has no 01 account yet or the market spec
   * isn't loaded.
   */
  async getMaxNotional(wallet: PublicKey, symbol: string): Promise<number | null> {
    if (!this.isInitialized) return null
    const spec = this.getMarketSpec(symbol)
    if (!spec || spec.imf <= 0) return null
    // Skip the /user round-trip if we already have a session — it carries the accountId.
    let accountId: number | null = this.session?.accountId ?? null
    if (accountId === null) {
      const userInfo = await this.client.getUserInfo(wallet.toBase58())
      if (!userInfo?.accountIds?.length) return null
      accountId = userInfo.accountIds[0]
    }
    const account = await this.client.getAccount(accountId)
    const m = account?.margins
    if (!m) return null
    const freeEquity = Math.max(0, m.omf - m.imf)
    return freeEquity / spec.imf
  }

  /**
   * Fetch open perpetual positions for a wallet.
   * Path: /user/{pubkey} → pick first accountId → /account/{id} → positions[].
   */
  async getPositions(wallet: PublicKey, options?: { includeTriggerPrices?: boolean }): Promise<ArbPosition[]> {
    if (!this.isInitialized) return []

    try {
      const pubkey = wallet.toBase58()
      const userInfo = await this.client.getUserInfo(pubkey)
      if (!userInfo || !userInfo.accountIds?.length) return []

      const accountId = userInfo.accountIds[0]
      const includeTriggerPrices = options?.includeTriggerPrices !== false
      const [account, triggers] = await Promise.all([
        this.client.getAccount(accountId),
        includeTriggerPrices
          ? this.client.getAccountTriggers(accountId).catch(err => {
              log.warn('[zo-arb] Failed to fetch triggers:', err instanceof Error ? err.message : err)
              return [] as any[]
            })
          : Promise.resolve([] as any[]),
      ])
      if (!account?.positions?.length) return []

      // Batch-fetch stats for every market with an open position in parallel,
      // avoiding N sequential HTTP calls inside the position loop.
      const marketIdsWithPositions = account.positions
        .filter(pos => pos.perp && this.specsById.has(pos.marketId))
        .map(pos => pos.marketId)
      const statsById = await this.client.fetchAllMarketStats(marketIdsWithPositions)

      const triggerMap = includeTriggerPrices
        ? buildZoTriggerMap(account, this.specsById, triggers)
        : new Map<string, { tp?: number; sl?: number }>()

      const positions: ArbPosition[] = []
      for (const pos of account.positions) {
        if (!pos.perp) continue
        const spec = this.specsById.get(pos.marketId)
        if (!spec) continue

        const baseSize = pos.perp.baseSize
        if (!Number.isFinite(baseSize) || baseSize === 0) continue
        const sizeAsset = Math.abs(baseSize)
        const direction: 'long' | 'short' = pos.perp.isLong ? 'long' : 'short'
        const entryPrice = pos.perp.price ?? 0
        const tradingPnl = pos.perp.tradingPnl ?? pos.perp.sizePricePnl ?? 0
        const fundingPnl = pos.perp.fundingPaymentPnl ?? 0

        const stats = statsById.get(spec.marketId)
        const mark = stats?.indexPrice ?? stats?.perpStats?.mark_price ?? entryPrice
        const sizeUsd = sizeAsset * mark
        const unrealizedPnl = direction === 'long'
          ? (mark - entryPrice) * sizeAsset
          : (entryPrice - mark) * sizeAsset

        // Per-position margin isn't on /account.positions; approximate via
        // initial-margin fraction so downstream risk tags have real numbers.
        const margin = spec.imf > 0 ? sizeUsd * spec.imf : 0
        const leverage = margin > 0 ? sizeUsd / margin : 0

        const triggerPrices = triggerMap.get(`${pos.marketId}:${direction}`)

        positions.push({
          symbol: baseFromZoSymbol(spec.symbol),
          direction,
          sizeUsd,
          sizeAsset,
          pnl: tradingPnl + fundingPnl,
          unrealizedPnl,
          fundingIncome: fundingPnl,
          entryPrice,
          leverage,
          margin,
          marketIndex: spec.marketId,
          triggerPrices,
        })
      }
      return positions
    } catch (error) {
      log.error('[zo-arb] getPositions failed:', error)
      return []
    }
  }

  /**
   * Fetch realized funding payments for the wallet's 01 account, filtered to
   * `[startTime, endTime)` in ms. Uses /account/{id}/history/funding paginated
   * by a string cursor; `fundingPnl` is already signed (+ earned, − paid).
   */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPaymentsResult> {
    if (!this.isInitialized || !this.walletPubkey) {
      return { payments: [], truncated: false }
    }

    const MAX_PAGES = 50
    const PAGE_SIZE = 50

    try {
      const userInfo = await this.client.getUserInfo(this.walletPubkey.toBase58())
      if (!userInfo?.accountIds?.length) return { payments: [], truncated: false }

      const since = startTime !== undefined ? new Date(startTime).toISOString() : undefined
      const until = endTime !== undefined ? new Date(endTime).toISOString() : undefined

      const perAccount = await Promise.all(
        userInfo.accountIds.map(async (accountId) => {
          const collected: FundingPayment[] = []
          let cursor: string | undefined
          let pages = 0
          let hasMore = true
          while (hasMore && pages < MAX_PAGES) {
            pages++
            const page = await this.client.getFundingHistory(accountId, {
              since, until, startInclusive: cursor, pageSize: PAGE_SIZE,
            })
            for (const entry of page.items) {
              const spec = this.specsById.get(entry.marketId)
              if (!spec) continue
              collected.push({
                symbol: baseFromZoSymbol(spec.symbol),
                amount: entry.fundingPnl,
                rate: 0, // Per-market funding rate not returned on the history row; would need a separate /stats lookup.
                timestamp: Date.parse(entry.time),
                direction: entry.positionSize >= 0 ? 'long' : 'short',
              })
            }
            cursor = page.nextStartInclusive ?? undefined
            hasMore = !!cursor
          }
          return { payments: collected, truncated: pages >= MAX_PAGES && hasMore }
        }),
      )

      const payments = perAccount.flatMap(r => r.payments)
      const truncated = perAccount.some(r => r.truncated)
      return { payments, truncated }
    } catch (error) {
      log.error('[zo-arb] Error fetching funding payments:', error)
      throw error
    }
  }

  async cleanup(): Promise<void> {
    this.specsById.clear()
    this.idBySymbol.clear()
    this.session = null
    this.tsOffsetSec = null
    this.tsOffsetRefreshedAt = 0
    this.isInitialized = false
  }

  /** Lazy-load the protobuf types only when a signed action is about to be built. */
  private async loadProto(): Promise<ZoProtoTypes> {
    if (!this.proto) this.proto = await loadZoSchema()
    return this.proto
  }

  // Cache (server_ts − local_ts_sec) so signed actions don't need a /timestamp
  // RTT each time. Engine allows 60s drift — refresh well inside that window.
  private tsOffsetSec: bigint | null = null
  private tsOffsetRefreshedAt = 0
  private static readonly TS_OFFSET_TTL_MS = 30_000

  /** Fetch server time as bigint; assert it's within engine's drift window. */
  private async freshTimestamp(): Promise<bigint> {
    if (this.tsOffsetSec === null || Date.now() - this.tsOffsetRefreshedAt > ZoArbProvider.TS_OFFSET_TTL_MS) {
      const serverTs = await this.client.getTimestamp()
      const localTs = BigInt(Math.floor(Date.now() / 1000))
      this.tsOffsetSec = serverTs - localTs
      this.tsOffsetRefreshedAt = Date.now()
      const driftAbs = this.tsOffsetSec < 0n ? -this.tsOffsetSec : this.tsOffsetSec
      if (driftAbs > BigInt(ZO_TIMESTAMP_DRIFT_SEC)) {
        log.warn(`[zo-arb] Server/local clock drift ${driftAbs}s (limit ${ZO_TIMESTAMP_DRIFT_SEC}s)`)
      }
      return serverTs
    }
    return BigInt(Math.floor(Date.now() / 1000)) + this.tsOffsetSec
  }

  /**
   * Extract orderId from a decoded Receipt.
   *
   * Receipt is a oneof `kind` (see zo-schema.proto § Receipt) — for
   * PlaceOrder the variant is `trade_or_place` (PlaceOrderResult). Our IOC
   * market orders should populate `fills[]` with Trade entries carrying the
   * `order_id`; a resting posted order would show in `posted.order_id`.
   * protobufjs may surface the variant via camelCase, snake_case, or under
   * `result.*` depending on decoder options, so probe all plausible paths.
   * Throws on engine rejection (err set) or if we can't locate a fill/posted
   * id — callers (notably arb leg rollback) rely on exceptions to detect
   * failure; never pretend success with a synthetic id.
   */
  private parseReceiptForOrder(receipt: any): { orderId: number; success: boolean } {
    if (receipt?.err) {
      const errCode = receipt.err.code ?? receipt.err
      throw new Error(`01 PlaceOrder rejected: ${JSON.stringify(errCode)}`)
    }
    const result =
      receipt?.tradeOrPlace ??
      receipt?.trade_or_place ??
      receipt?.result?.tradeOrPlace ??
      receipt?.result?.trade_or_place ??
      receipt?.placeOrderResult ??
      receipt?.result?.placeOrder
    const firstFill = result?.fills?.[0]
    const fillOrderId = firstFill?.orderId ?? firstFill?.order_id
    const postedOrderId = result?.posted?.orderId ?? result?.posted?.order_id
    const orderId = fillOrderId ?? postedOrderId
    if (orderId === undefined || orderId === null) {
      throw new Error(`01 PlaceOrder returned no fills and no posted order — engine likely rejected the action. Receipt: ${JSON.stringify(receipt).slice(0, 300)}`)
    }
    return { orderId: Number(orderId), success: true }
  }

  private toArbMarketInfo(spec: ZoMarketSpec, stats: ZoMarketStats): ArbMarketInfo | null {
    const canonicalSymbol = baseFromZoSymbol(spec.symbol)

    // Frozen markets or brand-new markets may return null perpStats / indexPrice.
    if (stats.frozen || !stats.perpStats) return null

    const oraclePrice = stats.indexPrice ?? stats.perpStats.mark_price ?? 0
    if (oraclePrice <= 0) return null

    const fundingRate = stats.perpStats.funding_rate
    const fundingRateApr = fundingRate * 24 * 365
    const openInterestUsd = stats.perpStats.open_interest * oraclePrice
    const nextFundingTime = Date.parse(stats.perpStats.next_funding_time)
    // imf values like 0.3333 / 0.1666 produce 3.0003 / 6.002 after 1/x — round to integer leverage.
    const maxLeverage = spec.imf > 0 ? Math.round(1 / spec.imf) : undefined

    const markPrice = stats.perpStats.mark_price ?? undefined
    const indexPrice = stats.indexPrice ?? undefined

    return {
      symbol: canonicalSymbol,
      marketIndex: spec.marketId,
      fundingRate,
      fundingRateApr,
      openInterest: {
        long: openInterestUsd, // Total OI in USD; 01 doesn't split by side.
        short: 0,
      },
      oraclePrice,
      markPrice,
      indexPrice,
      maxLeverage,
      fundingIntervalHours: 1,
      nextFundingTime: Number.isFinite(nextFundingTime) ? nextFundingTime : undefined,
    }
  }
}

export function createZoArbProvider(options: { baseUrl?: string; walletPubkey?: PublicKey } = {}): ZoArbProvider {
  return new ZoArbProvider(options)
}

const ZO_TP_KIND_STRINGS = new Set(['take_profit', 'takeprofit', 'tp'])
const ZO_SL_KIND_STRINGS = new Set(['stop_loss', 'stoploss', 'sl'])

/**
 * 01's REST shapes for triggers vary: dedicated `/triggers` entries, plus
 * defensively-supported `account.orders` and `pos.triggers`. `kind` may be
 * 0/1, "STOP_LOSS"/"TAKE_PROFIT", or "sl"/"tp"; price either scaled-int or
 * decimal. Falls back to position direction when `key.side` is absent.
 */
export function buildZoTriggerMap(
  account: { positions?: Array<{ marketId: number; perp?: { isLong: boolean } | null; triggers?: any[] }>; orders?: any[] },
  specsById: Map<number, ZoMarketSpec>,
  externalTriggers: any[] = [],
): Map<string, { tp?: number; sl?: number }> {
  const map = new Map<string, { tp?: number; sl?: number }>()

  const candidates: any[] = [...externalTriggers]
  if (Array.isArray(account.orders)) candidates.push(...account.orders)
  for (const pos of account.positions || []) {
    if (Array.isArray(pos.triggers)) candidates.push(...pos.triggers)
  }

  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue

    const trigger = raw.trigger ?? raw
    const key = trigger.key ?? trigger.triggerKey ?? trigger
    const kindRaw = key?.kind ?? trigger.kind ?? trigger.triggerKind
    const kindStr = typeof kindRaw === 'string' ? kindRaw.toLowerCase() : ''
    const isTp = kindRaw === 1 || ZO_TP_KIND_STRINGS.has(kindStr)
    const isSl = kindRaw === 0 || ZO_SL_KIND_STRINGS.has(kindStr)
    if (!isTp && !isSl) continue

    const marketId: number | undefined = trigger.marketId ?? trigger.market_id ?? raw.marketId ?? raw.market_id
    if (typeof marketId !== 'number') continue
    const spec = specsById.get(marketId)
    if (!spec) continue

    const triggerPriceRaw = trigger.triggerPrice ?? trigger.trigger_price ?? raw.triggerPrice ?? raw.trigger_price
    if (triggerPriceRaw === undefined || triggerPriceRaw === null) continue
    const triggerPriceText = String(triggerPriceRaw).trim()
    const triggerPriceNum = typeof triggerPriceRaw === 'number' ? triggerPriceRaw : parseFloat(triggerPriceText)
    if (!Number.isFinite(triggerPriceNum) || triggerPriceNum <= 0) continue

    // Integer-like values in the account payload are engine-scaled uint64s,
    // while decimal strings/numbers are already human USD prices.
    const isIntegerLike = !triggerPriceText.includes('.') && !triggerPriceText.includes('e') && !triggerPriceText.includes('E')
    const triggerPx = isIntegerLike
      ? triggerPriceNum / Math.pow(10, spec.priceDecimals)
      : triggerPriceNum

    // ASK=0 closes a long, BID=1 closes a short.
    const sideRaw = key?.side ?? trigger.side
    const sideStr = typeof sideRaw === 'string' ? sideRaw.toLowerCase() : ''
    let direction: 'long' | 'short' | undefined
    if (sideRaw === 0 || sideStr === 'ask') direction = 'long'
    else if (sideRaw === 1 || sideStr === 'bid') direction = 'short'
    else {
      const pos = account.positions?.find(p => p.marketId === marketId)
      if (pos?.perp) direction = pos.perp.isLong ? 'long' : 'short'
    }
    if (!direction) continue

    const mapKey = `${marketId}:${direction}`
    const entry = map.get(mapKey) || {}
    if (isTp) entry.tp = triggerPx
    else entry.sl = triggerPx
    map.set(mapKey, entry)
  }
  return map
}
