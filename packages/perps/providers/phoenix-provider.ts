import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
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
import { canonicalizeSymbol } from '../funding-rates/utils'
import { getPhoenixHttpClient, createPhoenixSdkClient, MarginType } from '../clients/phoenix-client'
import { Side, Direction, StopLossOrderKind } from '@ellipsis-labs/rise'
import type {
  PhoenixHttpClient,
  ExchangeMarketConfig,
  PhoenixClient,
  Authority,
  Symbol as PhoenixSymbol,
} from '@ellipsis-labs/rise'
import { log } from '../logger'

/** Phoenix referral code used to onboard Paystream wallets. */
const PHOENIX_INVITE_CODE = 'PAYSTREAM'
const PHOENIX_INVITE_MODE: 'access' | 'referral' = 'referral'

/** Phoenix markets are listed as bare base symbols (e.g. `SOL`, `ETH`). */
export function normalizePhoenixSymbol(symbol: string): string {
  const upper = symbol.toUpperCase()
  return upper.endsWith('-PERP') ? upper.slice(0, -'-PERP'.length) : upper
}

export function baseFromPhoenixSymbol(phoenixSymbol: string): string {
  return canonicalizeSymbol(phoenixSymbol.toUpperCase())
}

interface PhoenixFundingPoint {
  fundingRate: number
  markPrice: number
  timestampSec: number
}

interface PhoenixPositionTrigger {
  trigger: { triggerPriceTicks: string }
  status: string
}

interface PhoenixPositionSnapshotLike {
  symbol: string
  basePositionLots: string
  entryPriceTicks: string
  accumulatedFundingQuoteLots?: string | null
  takeProfitTriggers?: ReadonlyArray<PhoenixPositionTrigger>
  stopLossTriggers?: ReadonlyArray<PhoenixPositionTrigger>
}

/**
 * Phoenix (phoenix.trade) perpetuals provider.
 *
 * Read paths use `PhoenixHttpClient` (no RPC); execution paths build Solana
 * instructions via `createPhoenixSdkClient` and are filled in in later stages.
 *
 * Margin model: isolated only (one Phoenix subaccount per market). The trader
 * PDA is shared (`traderPdaIndex = 0`); each market gets its own
 * `traderSubaccountIndex` resolved at execution time.
 */
export class PhoenixArbProvider implements IArbProvider {
  name = 'phoenix'

  readonly marginType = MarginType.Isolated

  private http: PhoenixHttpClient
  private sdk: PhoenixClient | null = null
  private walletPubkey: PublicKey | null
  private isInitialized = false
  private configsByBase = new Map<string, ExchangeMarketConfig>()

  constructor(options: { walletPubkey?: PublicKey } = {}) {
    this.http = getPhoenixHttpClient()
    this.walletPubkey = options.walletPubkey ?? null
  }

  getHttpClient(): PhoenixHttpClient {
    return this.http
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return

    try {
      await this.refreshConfigs()
      this.isInitialized = true
      log.info(`[phoenix-arb] Provider initialized with ${this.configsByBase.size} markets`)
    } catch (error) {
      log.error('[phoenix-arb] Failed to initialize:', error)
      throw error
    }
  }

  private async refreshConfigs(): Promise<void> {
    const configs = await this.http.markets().getMarkets()
    this.configsByBase.clear()
    for (const cfg of configs) {
      if (cfg.marketStatus !== 'active') continue
      const base = baseFromPhoenixSymbol(cfg.symbol)
      // If the API ever returns multiple active listings for the same base
      // (e.g. duplicate GOLD assetIds), keep the highest-leverage variant.
      const existing = this.configsByBase.get(base)
      if (existing) {
        const newMax = maxLeverageFromTiers(cfg)
        const oldMax = maxLeverageFromTiers(existing)
        if (newMax <= oldMax) continue
      }
      this.configsByBase.set(base, cfg)
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) await this.initialize()
  }

  async getMarketInfo(symbol: string): Promise<ArbMarketInfo | null> {
    await this.ensureInitialized()

    const base = canonicalizeSymbol(symbol.toUpperCase())
    const cfg = this.configsByBase.get(base)
    if (!cfg) return null

    try {
      const [overview, stats] = await Promise.all([
        this.http.funding().getFundingOverview({ perMarketLimit: 1 }),
        this.http.markets().getMarketStatsHistory(cfg.symbol, { limit: 1 }).catch(() => null),
      ])
      const series = overview.series.find(s => baseFromPhoenixSymbol(s.symbol) === base)
      const point = series?.points[0]
      const funding = point ? toFundingPoint(point) : null
      const stat = stats?.stats?.[0]
      const oiUsd = stat && stat.open_interest > 0 && stat.mark_price > 0
        ? stat.open_interest * stat.mark_price
        : undefined
      return toArbMarketInfo(cfg, funding, oiUsd)
    } catch (error) {
      log.warn(`[phoenix-arb] getMarketInfo(${symbol}) failed:`, error)
      return null
    }
  }

  async getAllMarkets(): Promise<ArbMarketInfo[]> {
    await this.ensureInitialized()

    const [fundingByBase, oiByBase] = await Promise.all([
      this.fetchFundingByBase(),
      this.getOpenInterestSnapshot(),
    ])

    const markets: ArbMarketInfo[] = []
    for (const [base, cfg] of this.configsByBase) {
      const oi = oiByBase.get(base)
      const oiUsd = oi ? oi.openInterest * oi.markPrice : undefined
      const info = toArbMarketInfo(cfg, fundingByBase.get(base) ?? null, oiUsd)
      if (info) markets.push(info)
    }
    return markets
  }

  private async fetchFundingByBase(): Promise<Map<string, PhoenixFundingPoint>> {
    const out = new Map<string, PhoenixFundingPoint>()
    try {
      const overview = await this.http.funding().getFundingOverview({ perMarketLimit: 1 })
      for (const series of overview.series) {
        const base = baseFromPhoenixSymbol(series.symbol)
        const point = series.points[0]
        if (!point) continue
        const parsed = toFundingPoint(point)
        // Multiple series can share the same base (duplicate marketIds for the
        // same asset). Prefer the most recent settlement.
        const existing = out.get(base)
        if (existing && existing.timestampSec >= parsed.timestampSec) continue
        out.set(base, parsed)
      }
    } catch (error) {
      log.warn('[phoenix-arb] getFundingOverview failed, returning markets without live funding:', error)
    }
    return out
  }

  async getFees(symbol: string): Promise<ArbFeeInfo> {
    await this.ensureInitialized()
    const base = canonicalizeSymbol(symbol.toUpperCase())
    const cfg = this.configsByBase.get(base)
    if (!cfg) return {}
    return {
      takerFeeBps: cfg.takerFee * 10000,
      makerFeeBps: cfg.makerFee * 10000,
    }
  }

  async buildOpenPositionTransaction(
    _params: OpenPositionParams,
    _wallet: PublicKey,
  ): Promise<OpenPositionResult> {
    throw new Error('phoenix uses buildPlaceMarketOrderTransaction(), not buildOpenPositionTransaction')
  }

  async buildClosePositionTransaction(
    _symbol: string,
    _direction: 'long' | 'short',
    _wallet: PublicKey,
  ): Promise<ClosePositionResult> {
    throw new Error('phoenix uses buildCloseMarketOrderTransaction(), not buildClosePositionTransaction')
  }

  async getPositions(wallet: PublicKey): Promise<ArbPosition[]> {
    await this.ensureInitialized()

    const authority = wallet.toBase58()
    let state
    try {
      // Use the richer trader-state endpoint: it returns server-computed
      // unrealized PnL, liquidation price, position value, and TP/SL — so we
      // don't have to recompute them locally against a separately-fetched
      // mark price.
      state = await this.http.traders().getTraderState(authority, { pdaIndex: 0 })
    } catch (error) {
      // Unregistered traders or empty state surface as 4xx; treat as no positions.
      log.warn(`[phoenix-arb] getPositions state failed for ${authority}:`, error instanceof Error ? error.message : error)
      return []
    }
    const traders = state?.traders ?? []
    if (traders.length === 0) {
      log.warn(`[phoenix-arb] getPositions returned no traders for ${authority}`)
      return []
    }

    const positions: ArbPosition[] = []
    let rawPositionsCount = 0
    let zeroSizeCount = 0
    let missingConfigCount = 0
    const missingConfigSymbols = new Set<string>()
    for (const trader of traders) {
      // Phoenix uses isolated margin: each subaccount holds its own collateral
      // that backs the one position inside it. Other DEXes report a per-position
      // margin; mirror that by surfacing the subaccount's collateralBalance.
      const subMargin = parseFloat(trader.collateralBalance?.ui ?? '0')
      for (const pos of trader.positions ?? []) {
        rawPositionsCount++
        const sizeRaw = pos.positionSize?.value ?? 0
        if (sizeRaw === 0) {
          zeroSizeCount++
          continue
        }

        const base = baseFromPhoenixSymbol(pos.symbol)
        const cfg = this.configsByBase.get(base)
        if (!cfg) {
          missingConfigCount++
          missingConfigSymbols.add(pos.symbol)
          continue
        }

        const direction: 'long' | 'short' = sizeRaw > 0 ? 'long' : 'short'
        const sizeAsset = Math.abs(sizeRaw) / Math.pow(10, pos.positionSize.decimals)
        const entryPrice = parseFloat(pos.entryPrice?.ui ?? '0')
        const sizeUsd = parseFloat(pos.positionValue?.ui ?? '0')
        const unrealizedPnl = parseFloat(pos.unrealizedPnl?.ui ?? '0')
        const accumulatedFunding = parseFloat(pos.accumulatedFunding?.ui ?? '0')
        const unsettledFunding = parseFloat(pos.unsettledFunding?.ui ?? '0')
        const fundingIncome = accumulatedFunding + unsettledFunding
        const liquidationPrice = pos.liquidationPrice ? parseFloat(pos.liquidationPrice.ui) : undefined
        const leverage = subMargin > 0 ? sizeUsd / subMargin : 0

        const tp = pos.takeProfitPrice ? parseFloat(pos.takeProfitPrice.ui) : undefined
        const sl = pos.stopLossPrice ? parseFloat(pos.stopLossPrice.ui) : undefined
        const triggerPrices = (tp != null || sl != null) ? { tp, sl } : undefined

        positions.push({
          symbol: base,
          direction,
          sizeUsd,
          sizeAsset,
          pnl: unrealizedPnl + fundingIncome,
          unrealizedPnl,
          fundingIncome,
          entryPrice,
          leverage,
          margin: subMargin,
          liquidationPrice,
          marketIndex: cfg.assetId,
          triggerPrices,
        })
      }
    }

    if (positions.length === 0) {
      log.warn(
        `[phoenix-arb] getPositions parsed 0 live positions for ${authority} ` +
        `(traders=${traders.length}, rawPositions=${rawPositionsCount}, zeroSize=${zeroSizeCount}, missingConfigs=${missingConfigCount}, missingSymbols=${Array.from(missingConfigSymbols).join(',') || 'none'})`,
      )
    }

    return positions
  }

  /**
   * Read collateral state for the wallet's Phoenix trader PDA.
   *
   * Phoenix uses isolated margin: a single "main" subaccount holds deposits
   * and unallocated collateral, and one isolated subaccount per asset holds
   * the margin locked to that position. We treat any subaccount with no open
   * position as part of the free/main pool, and any subaccount with positions
   * as locked margin.
   *
   *  - totalUsdc: sum of collateral across all subaccounts
   *  - freeUsdc:  collateral on subaccounts with zero open positions (the
   *               main pool that funds new trades)
   *  - lockedUsdc: collateral pinned to isolated positions (totalUsdc - freeUsdc)
   *  - positionsCount: number of subaccounts holding a non-zero position
   *
   * Returns a zero-balance shape on unregistered traders (4xx from API).
   */
  async getBalance(authority: string): Promise<{
    totalUsdc: number
    accountEquityUsdc: number
    freeUsdc: number
    lockedUsdc: number
    totalPositionValueUsdc: number
    positionsCount: number
  }> {
    await this.ensureInitialized()

    let snapshot
    try {
      snapshot = await this.http.traders().getTraderStateSnapshot(authority, { traderPdaIndex: 0 })
    } catch (error) {
      log.warn(`[phoenix-arb] getBalance snapshot failed for ${authority}:`, error instanceof Error ? error.message : error)
      return {
        totalUsdc: 0,
        accountEquityUsdc: 0,
        freeUsdc: 0,
        lockedUsdc: 0,
        totalPositionValueUsdc: 0,
        positionsCount: 0,
      }
    }

    const subaccounts = snapshot?.snapshot?.subaccounts ?? []
    const markByBase = await this.fetchMarkPricesByBase()
    let totalUsdc = 0
    let freeUsdc = 0
    let totalPositionValueUsdc = 0
    let unrealizedPnlUsd = 0
    let fundingIncomeUsd = 0
    let positionsCount = 0

    for (const sub of subaccounts) {
      const collateral = quoteLotsToUsd(sub.collateral)
      totalUsdc += collateral

      let hasOpenPosition = false
      for (const pos of sub.positions ?? []) {
        let lots: bigint
        try { lots = BigInt(pos.basePositionLots) } catch { continue }
        if (lots !== 0n) {
          hasOpenPosition = true
          positionsCount++

          const base = baseFromPhoenixSymbol(pos.symbol)
          const cfg = this.configsByBase.get(base)
          if (!cfg) continue

          const sizeAsset = absBigIntAsNumber(lots) / Math.pow(10, cfg.baseLotsDecimals)
          const entryTicks = safeBigInt(pos.entryPriceTicks)
          const entryPrice = entryTicks != null ? ticksBigintToUsd(entryTicks, cfg) : 0
          const markPrice = markByBase.get(base) ?? entryPrice

          if (markPrice > 0 && sizeAsset > 0) {
            totalPositionValueUsdc += sizeAsset * markPrice
          }
          if (entryPrice > 0 && markPrice > 0 && sizeAsset > 0) {
            unrealizedPnlUsd += lots > 0n
              ? (markPrice - entryPrice) * sizeAsset
              : (entryPrice - markPrice) * sizeAsset
          }
          fundingIncomeUsd += quoteLotsToUsd(pos.accumulatedFundingQuoteLots)
        }
      }
      if (!hasOpenPosition) freeUsdc += collateral
    }

    const lockedUsdc = Math.max(totalUsdc - freeUsdc, 0)
    const accountEquityUsdc = totalUsdc + unrealizedPnlUsd + fundingIncomeUsd

    return {
      totalUsdc,
      accountEquityUsdc,
      freeUsdc,
      lockedUsdc,
      totalPositionValueUsdc,
      positionsCount,
    }
  }

  private async fetchMarkPricesByBase(): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    try {
      const overview = await this.http.funding().getFundingOverview({ perMarketLimit: 1 })
      for (const series of overview.series) {
        const base = baseFromPhoenixSymbol(series.symbol)
        const point = series.points[0]
        if (!point) continue
        const mark = Number(point.markPrice)
        if (!Number.isFinite(mark) || mark <= 0) continue
        const existing = out.get(base)
        if (existing != null && point.timestamp <= 0) continue
        out.set(base, mark)
      }
    } catch (error) {
      log.warn('[phoenix-arb] mark price fetch failed; falling back to entry price:', error)
    }
    return out
  }

  /**
   * Fetch latest open interest + mark price for every active Phoenix market.
   * Issues one `getMarketStatsHistory(symbol, { limit: 1 })` per market in
   * parallel — no aggregated OI endpoint exists in the HTTP API. Used by the
   * worker's OI monitor for cascade-risk tagging.
   */
  async getOpenInterestSnapshot(): Promise<Map<string, { openInterest: number; markPrice: number }>> {
    await this.ensureInitialized()
    const out = new Map<string, { openInterest: number; markPrice: number }>()
    const entries = Array.from(this.configsByBase.entries())

    await Promise.all(entries.map(async ([base, cfg]) => {
      try {
        const res = await this.http.markets().getMarketStatsHistory(cfg.symbol, { limit: 1 })
        const point = res.stats?.[0]
        if (!point) return
        const oi = Number(point.open_interest)
        const mark = Number(point.mark_price)
        if (!Number.isFinite(oi) || oi <= 0) return
        if (!Number.isFinite(mark) || mark <= 0) return
        out.set(base, { openInterest: oi, markPrice: mark })
      } catch {
        // per-market fetch failures are non-fatal — skip and continue
      }
    }))

    return out
  }

  /**
   * Fetch realized hourly funding payments for the wallet's Phoenix trader,
   * filtered to `[startTime, endTime)` in ms. Phoenix's
   * `/funding/trader/{authority}` endpoint expects timestamps in **seconds**
   * and returns per-hour `FundingHourlyEvent` rows (not cumulative — each row
   * is the payment delta for that hour). `fundingPayment` is signed
   * (+ earned, − paid).
   */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPaymentsResult> {
    if (!this.walletPubkey) return { payments: [], truncated: false }

    const MAX_PAGES = 50
    const PAGE_SIZE = 500

    const startSec = startTime !== undefined ? Math.floor(startTime / 1000) : undefined
    const endSec = endTime !== undefined ? Math.floor(endTime / 1000) : undefined

    const authority = this.walletPubkey.toBase58()
    const collected: FundingPayment[] = []
    let cursor: string | undefined
    let pages = 0
    let hasMore = true

    try {
      while (hasMore && pages < MAX_PAGES) {
        pages++
        const page = await this.http.funding().getTraderFundingHistory(authority, {
          startTime: startSec,
          endTime: endSec,
          limit: PAGE_SIZE,
          cursor,
        })

        for (const entry of page.events) {
          const amount = parseFloat(entry.fundingPayment)
          if (!Number.isFinite(amount)) continue
          const tsSec = Number(entry.timestamp)
          if (!Number.isFinite(tsSec)) continue
          const ratePct = parseFloat(entry.fundingRatePercentage)
          const rate = Number.isFinite(ratePct) ? ratePct / 100 : 0
          const side = entry.positionSide?.toLowerCase()
          const direction: 'long' | 'short' | undefined =
            side === 'long' ? 'long' : side === 'short' ? 'short' : undefined

          collected.push({
            symbol: baseFromPhoenixSymbol(entry.symbol),
            amount,
            rate,
            timestamp: tsSec * 1000,
            direction,
          })
        }

        cursor = page.nextCursor ?? undefined
        hasMore = page.hasMore && !!cursor
      }

      return { payments: collected, truncated: pages >= MAX_PAGES && hasMore }
    } catch (error) {
      // Unregistered traders surface as 4xx; treat as no funding history.
      log.warn(`[phoenix-arb] getFundingPayments failed for ${authority}:`, error instanceof Error ? error.message : error)
      return { payments: [], truncated: false }
    }
  }

  /** Lot size (asset units) for a market — derived from `baseLotsDecimals`. */
  getLotSize(symbol: string): number {
    const cfg = this.configsByBase.get(canonicalizeSymbol(symbol.toUpperCase()))
    if (!cfg) return 0.01
    return Math.pow(10, -cfg.baseLotsDecimals)
  }

  /** Highest leverage tier for a market (used by route preflight). */
  getMaxLeverage(symbol: string): number {
    const cfg = this.configsByBase.get(canonicalizeSymbol(symbol.toUpperCase()))
    if (!cfg) return 0
    return Math.round(maxLeverageFromTiers(cfg))
  }

  /**
   * Build a legacy Solana Transaction that opens an isolated-margin market
   * position. Phoenix's HTTP `placeIsolatedMarketOrder` endpoint returns
   * server-built instructions: it (a) auto-allocates a per-asset
   * `traderSubaccountIndex` under `pdaIndex=0`, (b) registers the trader
   * subaccount if missing, (c) transfers `transferAmount` USDC from main
   * collateral into the isolated subaccount, and (d) places the IOC market
   * order. Caller must set the recent blockhash and sign+submit.
   */
  async buildPlaceMarketOrderTransaction(params: {
    symbol: string
    direction: 'long' | 'short'
    sizeAsset: number
    marginUsd: number
    authority: string
    maxPriceUsd?: number
  }): Promise<{
    transaction: Transaction
    instructionCount: number
    symbol: string
    direction: 'long' | 'short'
    sizeAsset: number
    marginUsd: number
  }> {
    await this.ensureInitialized()
    if (params.sizeAsset <= 0) throw new Error('phoenix: sizeAsset must be positive')
    if (params.marginUsd <= 0) throw new Error('phoenix: marginUsd must be positive')
    await this.ensureTraderRegistered(params.authority)

    const phoenixSymbol = normalizePhoenixSymbol(params.symbol)
    const cfg = this.configsByBase.get(canonicalizeSymbol(params.symbol.toUpperCase()))
    if (!cfg) throw new Error(`phoenix: market not found for ${params.symbol}`)

    const baseLots = baseUnitsToBaseLotsInt(params.sizeAsset, cfg.baseLotsDecimals)
    if (baseLots <= 0) {
      throw new Error(`phoenix: order size ${params.sizeAsset} below lot size for ${phoenixSymbol}`)
    }
    const transferAmount = toUsdcMicros(params.marginUsd)

    const ixs = await this.http.orders().placeIsolatedMarketOrder({
      authority: params.authority,
      symbol: phoenixSymbol,
      side: params.direction === 'long' ? 'bid' : 'ask',
      numBaseLots: baseLots,
      transferAmount,
      pdaIndex: 0,
      isReduceOnly: false,
    })

    const tx = new Transaction()
    tx.feePayer = new PublicKey(params.authority)
    for (const ix of ixs) {
      tx.add(toWeb3Instruction(ix as unknown as KitInstructionLike))
    }
    return {
      transaction: tx,
      instructionCount: ixs.length,
      symbol: phoenixSymbol,
      direction: params.direction,
      sizeAsset: params.sizeAsset,
      marginUsd: params.marginUsd,
    }
  }

  /**
   * Build a legacy Solana Transaction that closes an isolated-margin
   * position via an opposite-side reduce-only market order. The HTTP
   * endpoint resolves the existing isolated subaccount for the asset.
   * `skipTransferToParent=false` (default) returns the freed collateral to
   * the main pool on close.
   */
  async buildCloseMarketOrderTransaction(params: {
    symbol: string
    direction: 'long' | 'short'
    sizeAsset: number
    authority: string
  }): Promise<{
    transaction: Transaction
    instructionCount: number
    symbol: string
    direction: 'long' | 'short'
    sizeAsset: number
  }> {
    await this.ensureInitialized()
    if (params.sizeAsset <= 0) throw new Error('phoenix: sizeAsset must be positive')
    await this.ensureTraderRegistered(params.authority)

    const phoenixSymbol = normalizePhoenixSymbol(params.symbol)
    const cfg = this.configsByBase.get(canonicalizeSymbol(params.symbol.toUpperCase()))
    if (!cfg) throw new Error(`phoenix: market not found for ${params.symbol}`)

    const baseLots = baseUnitsToBaseLotsInt(params.sizeAsset, cfg.baseLotsDecimals)
    if (baseLots <= 0) {
      throw new Error(`phoenix: close size ${params.sizeAsset} below lot size for ${phoenixSymbol}`)
    }

    const ixs = await this.http.orders().placeIsolatedMarketOrder({
      authority: params.authority,
      symbol: phoenixSymbol,
      side: params.direction === 'long' ? 'ask' : 'bid',
      numBaseLots: baseLots,
      pdaIndex: 0,
      isReduceOnly: true,
    })

    const tx = new Transaction()
    tx.feePayer = new PublicKey(params.authority)
    for (const ix of ixs) {
      tx.add(toWeb3Instruction(ix as unknown as KitInstructionLike))
    }
    return {
      transaction: tx,
      instructionCount: ixs.length,
      symbol: phoenixSymbol,
      direction: params.direction,
      sizeAsset: params.sizeAsset,
    }
  }

  /**
   * Build a legacy Solana Transaction that attaches a take-profit trigger to
   * an open isolated-margin position for `symbol`. Caller signs+submits.
   */
  async buildSetTakeProfitTransaction(params: {
    symbol: string
    triggerPrice: number
    authority: string
  }): Promise<{ transaction: Transaction; instructionCount: number; direction: 'long' | 'short' }> {
    return this.buildPlaceTriggerTransaction({ ...params, type: 'tp' })
  }

  /**
   * Build a legacy Solana Transaction that attaches a stop-loss trigger to
   * an open isolated-margin position for `symbol`. Caller signs+submits.
   */
  async buildSetStopLossTransaction(params: {
    symbol: string
    triggerPrice: number
    authority: string
  }): Promise<{ transaction: Transaction; instructionCount: number; direction: 'long' | 'short' }> {
    return this.buildPlaceTriggerTransaction({ ...params, type: 'sl' })
  }

  private async buildPlaceTriggerTransaction(params: {
    symbol: string
    triggerPrice: number
    authority: string
    type: 'tp' | 'sl'
  }): Promise<{ transaction: Transaction; instructionCount: number; direction: 'long' | 'short' }> {
    await this.ensureInitialized()
    if (params.triggerPrice <= 0) throw new Error('phoenix: triggerPrice must be positive')
    await this.ensureTraderRegistered(params.authority)

    const phoenixSymbol = normalizePhoenixSymbol(params.symbol)
    const cfg = this.configsByBase.get(canonicalizeSymbol(params.symbol.toUpperCase()))
    if (!cfg) throw new Error(`phoenix: market not found for ${params.symbol}`)
    if (cfg.tickSize <= 0) throw new Error(`phoenix: invalid tickSize for ${phoenixSymbol}`)

    // Locate the isolated subaccount holding the position for this symbol and
    // derive direction from the signed base position lots.
    const snapshot = await this.http.traders().getTraderStateSnapshot(params.authority, { traderPdaIndex: 0 })
    const located = locateSymbolPosition(snapshot.snapshot.subaccounts, phoenixSymbol)
    if (!located) throw new Error(`phoenix: no open position for ${phoenixSymbol}`)
    const { subaccountIndex, direction, position } = located

    // Phoenix takes trigger/execution prices in ticks (bigint). For an SL we
    // intentionally re-use triggerPrice as executionPrice so the IOC match
    // walks at most through the trigger; the engine still fills at book
    // price up to that bound.
    const triggerTicks = priceUsdToTicks(params.triggerPrice, cfg)
    const { tradeSide, executionDirection } = resolveTriggerSemantics(direction, params.type)

    const sdk = this.getSdkClient()
    const tx = new Transaction()
    tx.feePayer = new PublicKey(params.authority)

    const activeTriggerExists = params.type === 'tp'
      ? hasActiveTrigger(position.takeProfitTriggers)
      : hasActiveTrigger(position.stopLossTriggers)
    if (activeTriggerExists) {
      const cancelIx = await sdk.ixs.buildCancelStopLoss({
        authority: params.authority as Authority,
        symbol: phoenixSymbol as PhoenixSymbol,
        executionDirection,
        traderPdaIndex: 0,
        traderSubaccountIndex: subaccountIndex,
      })
      tx.add(toWeb3Instruction(cancelIx as unknown as KitInstructionLike))
    }

    const ix = await sdk.ixs.buildPlaceStopLoss({
      authority: params.authority as Authority,
      symbol: phoenixSymbol as PhoenixSymbol,
      triggerPrice: triggerTicks,
      executionPrice: triggerTicks,
      tradeSide,
      executionDirection,
      orderKind: StopLossOrderKind.IOC,
      traderPdaIndex: 0,
      traderSubaccountIndex: subaccountIndex,
    })

    tx.add(toWeb3Instruction(ix as unknown as KitInstructionLike))
    return { transaction: tx, instructionCount: activeTriggerExists ? 2 : 1, direction }
  }

  /**
   * Idempotently grant the wallet Phoenix access. No-op if the wallet is
   * already whitelisted. Must be called before any read or write that needs
   * trader state (deposit, trade, position read, etc.).
   */
  async ensureTraderRegistered(authority: string): Promise<void> {
    const wallet = authority.trim()
    if (!wallet) throw new Error('phoenix: ensureTraderRegistered requires a wallet authority')

    const status = await this.http.invite().checkWallet(wallet)
    if (status.whitelisted) return

    try {
      if (PHOENIX_INVITE_MODE === 'referral') {
        await this.http.invite().activateInviteWithReferral({ authority: wallet, referral_code: PHOENIX_INVITE_CODE })
      } else {
        await this.http.invite().activateInvite({ authority: wallet, code: PHOENIX_INVITE_CODE })
      }
      log.info(`[phoenix-arb] Activated invite for ${wallet} (mode=${PHOENIX_INVITE_MODE})`)
    } catch (error) {
      // Phoenix returns 409 user_already_activated when the wallet activated
      // an invite previously (different referral, or before referral mode).
      // checkWallet's whitelisted flag can still lag, so we accept this as a
      // success signal — the order placement endpoint is the ground truth for
      // whether access is actually missing.
      if (isAlreadyActivatedError(error)) {
        log.info(`[phoenix-arb] ${wallet} already activated — skipping invite step`)
        return
      }
      // Race-safe: another concurrent caller may have just whitelisted this
      // wallet. Re-check before surfacing the error.
      const recheck = await this.http.invite().checkWallet(wallet).catch(() => null)
      if (recheck?.whitelisted) return
      throw error
    }
  }

  /**
   * Build a Solana legacy Transaction that deposits USDC into the trader's
   * Phoenix collateral pool (Ember-wrap + DepositFunds). Caller must set the
   * recent blockhash and submit the signed tx.
   *
   * Idempotently activates the wallet's Phoenix invite first.
   */
  async buildDepositTransaction(
    amountUsdc: number,
    authority: string,
  ): Promise<{ transaction: Transaction; instructionCount: number }> {
    if (amountUsdc <= 0) throw new Error('phoenix: deposit amount must be positive')
    await this.ensureTraderRegistered(authority)
    const sdk = this.getSdkClient()
    const amountBase = toUsdcBaseUnits(amountUsdc)
    const result = await sdk.ixs.buildDepositIxs({
      authority: authority as Authority,
      amount: amountBase,
    })
    const tx = new Transaction()
    tx.feePayer = new PublicKey(authority)
    for (const ix of result.instructions) {
      tx.add(toWeb3Instruction(ix as unknown as KitInstructionLike))
    }
    return { transaction: tx, instructionCount: result.instructions.length }
  }

  /**
   * Build a Solana legacy Transaction that withdraws USDC from Phoenix back
   * to the trader's USDC ATA. The tx enqueues into Phoenix's on-chain
   * `WithdrawQueue`; settlement to the SPL ATA happens once the queue
   * processes the entry, so the user-visible balance lags the tx
   * confirmation.
   */
  async buildWithdrawTransaction(
    amountUsdc: number,
    authority: string,
  ): Promise<{ transaction: Transaction; instructionCount: number }> {
    if (amountUsdc <= 0) throw new Error('phoenix: withdraw amount must be positive')
    await this.ensureTraderRegistered(authority)
    const sdk = this.getSdkClient()
    const amountBase = toUsdcBaseUnits(amountUsdc)
    const result = await sdk.ixs.buildWithdrawIxs({
      authority: authority as Authority,
      amount: amountBase,
    })
    const tx = new Transaction()
    tx.feePayer = new PublicKey(authority)
    for (const ix of result.instructions) {
      tx.add(toWeb3Instruction(ix as unknown as KitInstructionLike))
    }
    return { transaction: tx, instructionCount: result.instructions.length }
  }

  private getSdkClient(): PhoenixClient {
    if (!this.sdk) this.sdk = createPhoenixSdkClient()
    return this.sdk
  }

  async cleanup(): Promise<void> {
    this.isInitialized = false
    this.configsByBase.clear()
    if (this.sdk) {
      try { this.sdk.dispose() } catch { /* noop */ }
      this.sdk = null
    }
  }
}

function toUsdcBaseUnits(amountUsdc: number): bigint {
  const scaled = Math.round(amountUsdc * 1e6)
  if (!Number.isFinite(scaled) || scaled <= 0) {
    throw new Error(`phoenix: invalid USDC amount ${amountUsdc}`)
  }
  return BigInt(scaled)
}

/** USDC micros (1e6) as a number — matches the HTTP API's numeric `transferAmount`. */
function toUsdcMicros(amountUsdc: number): number {
  const scaled = Math.round(amountUsdc * 1e6)
  if (!Number.isFinite(scaled) || scaled <= 0) {
    throw new Error(`phoenix: invalid USDC amount ${amountUsdc}`)
  }
  return scaled
}

/** Convert asset units → integer base lots, flooring to lot size. */
function baseUnitsToBaseLotsInt(baseUnits: number, baseLotsDecimals: number): number {
  if (!Number.isFinite(baseUnits) || baseUnits <= 0) return 0
  const factor = Math.pow(10, baseLotsDecimals)
  return Math.floor(baseUnits * factor)
}

type TickScale = Pick<ExchangeMarketConfig, 'tickSize' | 'baseLotsDecimals'>

function priceUsdToTicks(priceUsd: number, scale: TickScale): bigint {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error(`phoenix: invalid trigger price ${priceUsd}`)
  }
  if (!Number.isFinite(scale.tickSize) || scale.tickSize <= 0) {
    throw new Error(`phoenix: invalid tick size ${scale.tickSize}`)
  }
  const priceMicros = BigInt(Math.round(priceUsd * 1_000_000))
  const denom = BigInt(scale.tickSize) * 10n ** BigInt(scale.baseLotsDecimals)
  const ticks = priceMicros / denom
  if (ticks <= 0n) throw new Error(`phoenix: trigger price ${priceUsd} below one tick`)
  return ticks
}

function safeBigInt(value: string | null | undefined): bigint | null {
  if (value == null) return null
  try { return BigInt(value) } catch { return null }
}

function absBigIntAsNumber(value: bigint): number {
  const abs = value < 0n ? -value : value
  return Number(abs)
}

// Phoenix quote token is USDC (6 decimals); quote lots map 1:1 to USDC micros.
function quoteLotsToUsd(value: string | number | null | undefined): number {
  if (value == null) return 0
  const lots = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(lots)) return 0
  return lots / 1e6
}

function ticksBigintToUsd(ticks: bigint, scale: TickScale): number {
  return Number(ticks) * scale.tickSize * Math.pow(10, scale.baseLotsDecimals) / 1_000_000
}

interface LocatedPosition {
  subaccountIndex: number
  direction: 'long' | 'short'
  position: PhoenixPositionSnapshotLike
}

function locateSymbolPosition(
  subaccounts: ReadonlyArray<{
    subaccountIndex: number
    positions: ReadonlyArray<PhoenixPositionSnapshotLike>
  }>,
  phoenixSymbol: string,
): LocatedPosition | null {
  const target = phoenixSymbol.toUpperCase()
  for (const sub of subaccounts) {
    for (const pos of sub.positions) {
      if (pos.symbol.toUpperCase() !== target) continue
      let lots: bigint
      try { lots = BigInt(pos.basePositionLots) } catch { continue }
      if (lots === 0n) continue
      return {
        subaccountIndex: sub.subaccountIndex,
        direction: lots > 0n ? 'long' : 'short',
        position: pos,
      }
    }
  }
  return null
}

function hasActiveTrigger(triggers: ReadonlyArray<PhoenixPositionTrigger> | undefined): boolean {
  for (const trigger of triggers ?? []) {
    const status = trigger.status.toLowerCase()
    if (
      status !== 'cancelled' &&
      status !== 'canceled' &&
      status !== 'executed' &&
      status !== 'expired' &&
      status !== 'closed'
    ) {
      return true
    }
  }
  return false
}

// Map (position direction, tp|sl) to Phoenix trigger semantics.
// Closing a long is a sell (Side.Ask); closing a short is a buy (Side.Bid).
// TP fires when price moves the favorable way relative to entry; SL the opposite.
function resolveTriggerSemantics(
  direction: 'long' | 'short',
  type: 'tp' | 'sl',
): { tradeSide: Side; executionDirection: Direction } {
  if (direction === 'long') {
    return {
      tradeSide: Side.Ask,
      executionDirection: type === 'tp' ? Direction.GreaterThan : Direction.LessThan,
    }
  }
  return {
    tradeSide: Side.Bid,
    executionDirection: type === 'tp' ? Direction.LessThan : Direction.GreaterThan,
  }
}

// AccountRole values from `@solana/instructions` — duplicated here to avoid
// taking a direct dependency on @solana/kit just for two enum constants.
const ACCOUNT_ROLE_WRITABLE_SIGNER = 3
const ACCOUNT_ROLE_READONLY_SIGNER = 2
const ACCOUNT_ROLE_WRITABLE = 1

interface KitAccountMetaLike {
  readonly address: string
  readonly role: number
}

interface KitInstructionLike {
  readonly programAddress: string
  readonly accounts: ReadonlyArray<KitAccountMetaLike>
  readonly data: Uint8Array | Readonly<Uint8Array>
}

function toWeb3Instruction(ix: KitInstructionLike): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress as string),
    keys: ix.accounts.map(meta => ({
      pubkey: new PublicKey(meta.address as unknown as string),
      isSigner: meta.role === ACCOUNT_ROLE_WRITABLE_SIGNER || meta.role === ACCOUNT_ROLE_READONLY_SIGNER,
      isWritable: meta.role === ACCOUNT_ROLE_WRITABLE_SIGNER || meta.role === ACCOUNT_ROLE_WRITABLE,
    })),
    data: Buffer.from(ix.data as Uint8Array),
  })
}

function maxLeverageFromTiers(cfg: ExchangeMarketConfig): number {
  let max = 0
  for (const tier of cfg.leverageTiers) {
    if (tier.maxLeverage > max) max = tier.maxLeverage
  }
  return max
}

// Phoenix `/v1/funding/overview` reports `fundingRate` in basis points (i.e.
// `fundingAmountPerUnit / markPrice * 10000`). Convert to a per-interval
// decimal fraction to match the convention used elsewhere in ArbMarketInfo.
function toFundingPoint(point: { timestamp: number; markPrice: string; fundingRate: string }): PhoenixFundingPoint {
  const markPrice = Number(point.markPrice)
  const fundingRateBps = Number(point.fundingRate)
  const fundingRate = Number.isFinite(fundingRateBps) ? fundingRateBps / 10000 : 0
  return {
    fundingRate,
    markPrice: Number.isFinite(markPrice) ? markPrice : 0,
    timestampSec: point.timestamp,
  }
}

/**
 * Phoenix's funding overview reports the **last settled** funding timestamp.
 * Settlement runs ~30 minutes after the interval boundary, so the naive
 * `last + interval` projection lands too early. Add a 30-minute cushion to
 * align the displayed countdown with actual settlement.
 */
const PHOENIX_FUNDING_SETTLEMENT_OFFSET_SEC = 30 * 60

function toArbMarketInfo(
  cfg: ExchangeMarketConfig,
  funding: PhoenixFundingPoint | null,
  oiUsd: number | undefined,
): ArbMarketInfo | null {
  const symbol = baseFromPhoenixSymbol(cfg.symbol)
  const maxLeverage = maxLeverageFromTiers(cfg) || undefined
  const fundingIntervalHours = cfg.fundingIntervalSeconds > 0
    ? cfg.fundingIntervalSeconds / 3600
    : 1

  const markPrice = funding?.markPrice && funding.markPrice > 0 ? funding.markPrice : undefined
  const oraclePrice = markPrice ?? 0
  if (oraclePrice <= 0) return null

  const fundingRate = funding ? funding.fundingRate : undefined
  const fundingRateApr = fundingRate != null
    ? fundingRate * (24 / fundingIntervalHours) * 365
    : undefined

  const nextFundingTime = funding && cfg.fundingIntervalSeconds > 0
    ? (funding.timestampSec + cfg.fundingIntervalSeconds + PHOENIX_FUNDING_SETTLEMENT_OFFSET_SEC) * 1000
    : undefined

  // Phoenix's `open_interest` is the total notional (long + short combined),
  // not a per-side breakdown. Surface the whole amount on `long` and leave
  // `short` at 0 — same convention as Hyperliquid.
  const openInterest = oiUsd != null && oiUsd > 0
    ? { long: oiUsd, short: 0 }
    : undefined

  return {
    symbol,
    fundingRate,
    fundingRateApr,
    oraclePrice,
    markPrice,
    maxLeverage: maxLeverage != null ? Math.round(maxLeverage) : undefined,
    fundingIntervalHours,
    nextFundingTime,
    openInterest,
  }
}

/**
 * Detect Phoenix's `409 user_already_activated` invite response. The rise
 * SDK surfaces HTTP failures as plain `Error` instances whose message
 * embeds the status line and JSON body (e.g.
 * `"POST .../v1/invite/activate-with-referral failed with HTTP 409 Conflict\n{"error":"user_already_activated"}"`),
 * so we sniff both the status and the error code substring.
 */
function isAlreadyActivatedError(error: unknown): boolean {
  if (!error) return false
  const msg = error instanceof Error ? error.message : String(error)
  return msg.includes('user_already_activated') || /HTTP\s+409\b/.test(msg)
}

export function createPhoenixArbProvider(
  options: { walletPubkey?: PublicKey } = {},
): PhoenixArbProvider {
  return new PhoenixArbProvider(options)
}
