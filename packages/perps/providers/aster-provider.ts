import { PublicKey, Transaction } from '@solana/web3.js'
import type {
  IArbProvider,
  ArbMarketInfo,
  ArbFeeInfo,
  OpenPositionParams,
  OpenPositionResult,
  ClosePositionResult,
  ArbPosition,
  FundingPaymentsResult,
} from '../types'
import { AsterClient, createAsterClient } from '../clients/aster-client'
import type { AsterSymbolInfo, AsterPremiumIndex, AsterFundingInfo } from '../clients/aster-client'
import { log } from '../logger'

/** Decimal places implied by a tick size string (e.g. "0.01" → 2, "1" → 0) */
function tickSizeDecimals(tickSize: string): number {
  return tickSize.includes('.') ? tickSize.split('.')[1].replace(/0+$/, '').length : 0
}

/** Round a price down/up to the nearest tick size */
function roundToTickSize(price: number, tickSize: string, direction: 'down' | 'up'): string {
  const tick = parseFloat(tickSize)
  const rounded = direction === 'down'
    ? Math.floor(price / tick) * tick
    : Math.ceil(price / tick) * tick
  return rounded.toFixed(tickSizeDecimals(tickSize))
}

/**
 * Normalize symbol to Aster format: SOL → SOLUSDT
 */
export function normalizeAsterSymbol(symbol: string): string {
  const base = symbol.toUpperCase().replace(/-PERP$/, '').replace(/-USD$/, '').replace(/USDC$/, '').replace(/USDT$/, '')
  return `${base}USDT`
}

/**
 * Extract base symbol from Aster symbol: SOLUSDT → SOL
 */
function baseFromAsterSymbol(asterSymbol: string): string {
  return asterSymbol.replace(/USDT$/, '')
}

/**
 * Aster DEX provider for arbitrage trading
 * Implements IArbProvider interface for perpetual trading on Aster
 *
 * Aster uses a Binance-compatible REST API with HMAC-SHA256 per-request signing.
 * API credentials are obtained via Solana wallet auth flow.
 */
export class AsterArbProvider implements IArbProvider {
  name = 'aster'

  private client: AsterClient
  private isInitialized = false
  private symbolMap: Map<string, string> = new Map() // base → aster symbol (e.g. SOL → SOLUSDC)
  private fundingIntervalMap: Map<string, number> = new Map() // aster symbol → fundingIntervalHours

  constructor() {
    this.client = createAsterClient()
  }

  /**
   * Set API credentials for signing trading operations
   */
  setApiCredentials(apiKey: string, apiSecret: string): void {
    this.client.setApiCredentials(apiKey, apiSecret)
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return

    try {
      const exchangeInfo = await this.client.getExchangeInfo()

      // Build symbol mapping
      for (const sym of exchangeInfo.symbols || []) {
        if (sym.contractType === 'PERPETUAL' && (sym.quoteAsset === 'USDT' || sym.quoteAsset === 'USDC')) {
          this.symbolMap.set(sym.baseAsset.toUpperCase(), sym.symbol)
        }
      }

      // Fetch leverage brackets and funding intervals in parallel
      const results = await Promise.allSettled([
        this.client.fetchAndCacheLeverageBrackets(),
        this.client.getFundingInfo(),
      ])

      const fundingInfos: AsterFundingInfo[] = results[1].status === 'fulfilled' ? results[1].value : []
      for (const info of fundingInfos) {
        this.fundingIntervalMap.set(info.symbol, info.fundingIntervalHours)
      }

      this.isInitialized = true
      log.info(`[aster-arb] Provider initialized with ${this.symbolMap.size} markets, ${this.fundingIntervalMap.size} funding intervals`)
    } catch (error) {
      log.error('[aster-arb] Failed to initialize:', error)
      throw error
    }
  }

  async getMarketInfo(symbol: string): Promise<ArbMarketInfo | null> {
    if (!this.isInitialized) throw new Error('Aster provider not initialized')

    const asterSymbol = normalizeAsterSymbol(symbol)

    try {
      const premiumIndex = await this.client.getPremiumIndex(asterSymbol) as AsterPremiumIndex
      if (!premiumIndex || !premiumIndex.markPrice) return null

      const markPrice = parseFloat(premiumIndex.markPrice)
      const fundingRate = parseFloat(premiumIndex.lastFundingRate || '0')
      const intervalHours = this.fundingIntervalMap.get(asterSymbol) ?? 8
      const fundingRateApr = fundingRate * (24 / intervalHours) * 365

      // Fetch open interest (base asset units → convert to USD)
      let openInterest: { long: number; short: number } | undefined
      try {
        const oiData = await this.client.getOpenInterest(asterSymbol)
        const oiUsd = parseFloat(oiData.openInterest) * markPrice
        if (oiUsd > 0) openInterest = { long: oiUsd, short: oiUsd }
      } catch { /* OI not critical */ }

      const symInfo = this.client.getSymbolInfo(asterSymbol)

      const indexPrice = parseFloat(premiumIndex.indexPrice || '0') || undefined

      return {
        symbol: baseFromAsterSymbol(asterSymbol),
        oraclePrice: markPrice,
        markPrice,
        indexPrice,
        fundingRate,
        fundingRateApr,
        openInterest,
        maxLeverage: symInfo?.maxLeverage ?? 20,
        fundingIntervalHours: intervalHours,
        nextFundingTime: premiumIndex.nextFundingTime || undefined,
      }
    } catch (error) {
      log.error(`[aster-arb] Error getting market info for ${symbol}:`, error)
      return null
    }
  }

  async getAllMarkets(): Promise<ArbMarketInfo[]> {
    if (!this.isInitialized) throw new Error('Aster provider not initialized')

    const markets: ArbMarketInfo[] = []

    try {
      const premiumIndexes = await this.client.getPremiumIndex() as AsterPremiumIndex[]

      // Filter valid markets first
      const validPIs = premiumIndexes.filter(pi => {
        if (!this.symbolMap.has(baseFromAsterSymbol(pi.symbol))) return false
        return parseFloat(pi.markPrice) > 0
      })

      // Fetch OI for all valid symbols in parallel
      const oiResults = await Promise.allSettled(
        validPIs.map(pi => this.client.getOpenInterest(pi.symbol))
      )

      for (let i = 0; i < validPIs.length; i++) {
        const pi = validPIs[i]
        const markPrice = parseFloat(pi.markPrice)
        const fundingRate = parseFloat(pi.lastFundingRate || '0')
        const intervalHours = this.fundingIntervalMap.get(pi.symbol) ?? 8
        const fundingRateApr = fundingRate * (24 / intervalHours) * 365

        let openInterest: { long: number; short: number } | undefined
        const oiResult = oiResults[i]
        if (oiResult.status === 'fulfilled') {
          const oiUsd = parseFloat(oiResult.value.openInterest) * markPrice
          if (oiUsd > 0) openInterest = { long: oiUsd, short: oiUsd }
        }

        const symInfo = this.client.getSymbolInfo(pi.symbol)

        const indexPrice = parseFloat(pi.indexPrice || '0') || undefined

        markets.push({
          symbol: baseFromAsterSymbol(pi.symbol),
          oraclePrice: markPrice,
          markPrice,
          indexPrice,
          fundingRate,
          fundingRateApr,
          openInterest,
          maxLeverage: symInfo?.maxLeverage ?? 20,
          fundingIntervalHours: intervalHours,
          nextFundingTime: pi.nextFundingTime || undefined,
        })
      }
    } catch (error) {
      log.error('[aster-arb] Error fetching all markets:', error)
    }

    return markets
  }

  async getFees(symbol: string): Promise<ArbFeeInfo> {
    return {
      takerFeeBps: 3.5, // 0.035%
      makerFeeBps: 1.0, // 0.01%
    }
  }

  async buildOpenPositionTransaction(
    params: OpenPositionParams,
    wallet: PublicKey
  ): Promise<OpenPositionResult> {
    const asterSymbol = normalizeAsterSymbol(params.symbol)
    const symInfo = this.client.getSymbolInfo(asterSymbol)
    const notionalUsd = params.marginUsd * params.leverage
    const fees = await this.getFees(params.symbol)
    const estimatedFees = notionalUsd * (fees.takerFeeBps || 3.5) / 10000

    // Get oracle price
    let oraclePrice = 0
    try {
      const pi = await this.client.getPremiumIndex(asterSymbol) as AsterPremiumIndex
      oraclePrice = parseFloat(pi.markPrice || '0')
    } catch { /* use 0 */ }

    return {
      transaction: new Transaction(), // Placeholder — REST-based
      direction: params.direction,
      notionalUsd,
      marginUsd: params.marginUsd,
      estimatedFees,
      oraclePrice,
      entryPrice: oraclePrice,
    }
  }

  async buildClosePositionTransaction(
    symbol: string,
    direction: 'long' | 'short',
    wallet: PublicKey
  ): Promise<ClosePositionResult> {
    return {
      transaction: new Transaction(), // Placeholder — REST-based
      direction,
      symbol: normalizeAsterSymbol(symbol),
    }
  }

  /**
   * Execute a trade on Aster via REST API
   */
  async executeTrade(
    params: OpenPositionParams
  ): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
    const asterSymbol = normalizeAsterSymbol(params.symbol)
    const symInfo = this.client.getSymbolInfo(asterSymbol)

    // Set leverage
    // Ensure single-asset mode (required before setting isolated margin)
    try {
      await this.client.setMultiAssetsMode(false)
      log.info(`[aster-arb] Set single-asset mode`)
    } catch (error) {
      const msg = String(error)
      // -4171: already in single-asset mode — safe to ignore
      if (!msg.includes('-4171') && !msg.includes('-4046')) {
        log.warn(`[aster-arb] Set single-asset mode warning:`, error)
      }
    }

    // Set isolated margin + leverage + cancel orders in parallel
    const [marginResult] = await Promise.allSettled([
      this.client.setMarginType(asterSymbol, 'ISOLATED'),
      this.client.setLeverage(asterSymbol, params.leverage).then(
        () => log.info(`[aster-arb] Set leverage: ${params.leverage}x for ${asterSymbol}`),
        (e) => log.warn(`[aster-arb] Set leverage warning (may already be set):`, e)
      ),
      this.client.cancelAllOrders(asterSymbol).catch(() => {}),
    ])

    // Only ignore -4046 "No need to change margin type" (already isolated)
    if (marginResult.status === 'rejected') {
      const msg = String(marginResult.reason)
      if (msg.includes('-4046')) {
        log.info(`[aster-arb] Margin type already ISOLATED for ${asterSymbol}`)
      } else {
        throw new Error(`Failed to set ISOLATED margin for ${asterSymbol}: ${msg}`)
      }
    }

    // Get current price
    const premiumIndex = await this.client.getPremiumIndex(asterSymbol) as AsterPremiumIndex
    const currentPrice = parseFloat(premiumIndex.markPrice)

    // Calculate size
    const sizeAsset = params.sizeAsset ?? (params.marginUsd * params.leverage) / currentPrice

    // Format quantity
    const qtyPrecision = symInfo?.quantityPrecision ?? 3
    const quantity = sizeAsset.toFixed(qtyPrecision)

    // Aggressive limit IOC (Aster has no true market orders)
    // Long: price × 1.01 (round up), Short: price × 0.99 (round down)
    const slippage = params.direction === 'long' ? 1.01 : 0.99
    const limitPrice = currentPrice * slippage
    const tickSize = symInfo?.tickSize ?? '0.01'
    const price = roundToTickSize(limitPrice, tickSize, params.direction === 'long' ? 'up' : 'down')

    const side = params.direction === 'long' ? 'BUY' : 'SELL'

    log.info(`[aster-arb] Placing ${side} IOC: ${quantity} ${asterSymbol} @ ${price}`)

    const result = await this.client.placeOrder({
      symbol: asterSymbol,
      side: side as 'BUY' | 'SELL',
      type: 'LIMIT',
      quantity,
      price,
      timeInForce: 'IOC',
    })

    return {
      orderId: result.orderId,
      success: true,
      avgPrice: result.avgPrice,
    }
  }

  /**
   * Close a position on Aster via REST API
   */
  async executeClose(
    symbol: string,
    direction: 'long' | 'short'
  ): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
    const asterSymbol = normalizeAsterSymbol(symbol)
    const symInfo = this.client.getSymbolInfo(asterSymbol)

    // Get position to determine size
    const positions = await this.client.getPositionRisk(asterSymbol)
    const position = positions.find(p => parseFloat(p.positionAmt) !== 0)
    if (!position) {
      throw new Error(`No position found for ${asterSymbol}`)
    }

    const posAmt = Math.abs(parseFloat(position.positionAmt))
    const qtyPrecision = symInfo?.quantityPrecision ?? 3
    const quantity = posAmt.toFixed(qtyPrecision)

    // Get current price for limit
    const premiumIndex = await this.client.getPremiumIndex(asterSymbol) as AsterPremiumIndex
    const currentPrice = parseFloat(premiumIndex.markPrice)

    // Opposite side with slippage
    const closeSide = direction === 'long' ? 'SELL' : 'BUY'
    const slippage = direction === 'long' ? 0.99 : 1.01
    const limitPrice = currentPrice * slippage
    const tickSize = symInfo?.tickSize ?? '0.01'
    const price = roundToTickSize(limitPrice, tickSize, direction === 'long' ? 'down' : 'up')

    log.info(`[aster-arb] Closing ${direction}: ${closeSide} ${quantity} ${asterSymbol} @ ${price} (reduceOnly)`)

    const result = await this.client.placeOrder({
      symbol: asterSymbol,
      side: closeSide as 'BUY' | 'SELL',
      type: 'LIMIT',
      quantity,
      price,
      timeInForce: 'IOC',
      reduceOnly: true,
    })

    return {
      orderId: result.orderId,
      success: true,
      avgPrice: result.avgPrice,
    }
  }

  async setStopLoss(symbol: string, triggerPrice: number) {
    return this._setTriggerOrder('sl', symbol, triggerPrice)
  }

  async setTakeProfit(symbol: string, triggerPrice: number) {
    return this._setTriggerOrder('tp', symbol, triggerPrice)
  }

  private async _setTriggerOrder(
    type: 'tp' | 'sl',
    symbol: string,
    triggerPrice: number,
  ): Promise<{ success: boolean; direction: 'long' | 'short' }> {
    const asterSymbol = normalizeAsterSymbol(symbol)
    const symInfo = this.client.getSymbolInfo(asterSymbol)

    const positions = await this.client.getPositionRisk(asterSymbol)
    const position = positions.find(p => parseFloat(p.positionAmt) !== 0)
    if (!position) {
      throw new Error(`No position found for ${asterSymbol} on Aster`)
    }

    const direction: 'long' | 'short' = parseFloat(position.positionAmt) > 0 ? 'long' : 'short'
    const side: 'BUY' | 'SELL' = direction === 'long' ? 'SELL' : 'BUY'

    const tickSize = symInfo?.tickSize ?? '0.01'
    const formattedTriggerPrice = triggerPrice.toFixed(tickSizeDecimals(tickSize))
    const orderType = type === 'tp' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET'

    log.info(`[aster-arb] Setting ${type.toUpperCase()}: ${side} ${asterSymbol} ${orderType} @ ${formattedTriggerPrice}`)

    await this.client.placeOrder({
      symbol: asterSymbol,
      side,
      type: orderType,
      stopPrice: formattedTriggerPrice,
      closePosition: true,
      workingType: 'MARK_PRICE',
    })

    return { success: true, direction }
  }

  async getPositions(wallet: PublicKey, options?: { includeTriggerPrices?: boolean }): Promise<ArbPosition[]> {
    if (!this.isInitialized) return []
    if (!this.client.hasCredentials()) return []

    try {
      const includeTriggerPrices = options?.includeTriggerPrices !== false
      const [positions, openOrders] = await Promise.all([
        this.client.getPositionRisk(),
        includeTriggerPrices
          ? this.client.getOpenOrders().catch(err => {
              log.warn('[aster-arb] Failed to fetch open orders for TP/SL:', err instanceof Error ? err.message : err)
              return []
            })
          : Promise.resolve([]),
      ])
      const result: ArbPosition[] = []

      // Filter to active positions first
      const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0)

      // TP/SL on a long closes via SELL, on a short via BUY.
      const triggerMap = new Map<string, { tp?: number; sl?: number }>()
      for (const order of openOrders) {
        if (!order.closePosition && !order.reduceOnly) continue
        const type = (order.type || '').toUpperCase()
        const isTp = type.includes('TAKE_PROFIT')
        const isSl = type.includes('STOP') && !isTp
        if (!isTp && !isSl) continue
        const triggerPx = parseFloat(order.stopPrice)
        if (!Number.isFinite(triggerPx) || triggerPx <= 0) continue
        const direction: 'long' | 'short' = order.side === 'SELL' ? 'long' : 'short'
        const key = `${order.symbol}:${direction}`
        const entry = triggerMap.get(key) || {}
        if (isTp) entry.tp = triggerPx
        else entry.sl = triggerPx
        triggerMap.set(key, entry)
      }

      // Fetch funding income for each active position's symbol in parallel
      const fundingBySymbol = new Map<string, number>()
      try {
        const incomeResults = await Promise.allSettled(
          activePositions.map(pos =>
            this.client.getIncome({ symbol: pos.symbol, incomeType: 'FUNDING_FEE', limit: 1000 })
          )
        )
        for (let i = 0; i < activePositions.length; i++) {
          const incomeResult = incomeResults[i]
          if (incomeResult.status === 'fulfilled') {
            const totalFunding = incomeResult.value.reduce((sum, entry) => sum + parseFloat(entry.income), 0)
            fundingBySymbol.set(activePositions[i].symbol, totalFunding)
          }
        }
      } catch (error) {
        log.warn('[aster-arb] Failed to fetch funding income, using mark-to-market PnL only:', error)
      }

      for (const pos of activePositions) {
        const posAmt = parseFloat(pos.positionAmt)

        const direction: 'long' | 'short' = posAmt > 0 ? 'long' : 'short'
        const sizeAsset = Math.abs(posAmt)
        const entryPrice = parseFloat(pos.entryPrice)
        const markPrice = parseFloat(pos.markPrice)
        const sizeUsd = Math.abs(parseFloat(pos.notional))
        const pricePnl = parseFloat(pos.unRealizedProfit)
        const fundingIncome = fundingBySymbol.get(pos.symbol) || 0
        const pnl = pricePnl + fundingIncome
        const leverage = parseFloat(pos.leverage)
        const margin = pos.isolatedMargin && parseFloat(pos.isolatedMargin) > 0
          ? parseFloat(pos.isolatedMargin)
          : sizeUsd / leverage

        const liquidationPrice = pos.liquidationPrice ? parseFloat(pos.liquidationPrice) : undefined

        const triggerPrices = triggerMap.get(`${pos.symbol}:${direction}`)

        result.push({
          symbol: baseFromAsterSymbol(pos.symbol),
          direction,
          sizeUsd,
          sizeAsset,
          pnl,
          unrealizedPnl: pricePnl,
          fundingIncome,
          entryPrice,
          leverage,
          margin,
          liquidationPrice: liquidationPrice && liquidationPrice > 0 ? liquidationPrice : undefined,
          triggerPrices,
        })
      }

      return result
    } catch (error) {
      log.error('[aster-arb] Error fetching positions:', error)
      return []
    }
  }

  /**
   * Get lot size (step size) for a symbol
   */
  getLotSize(symbol: string): number {
    const asterSymbol = normalizeAsterSymbol(symbol)
    const info = this.client.getSymbolInfo(asterSymbol)
    if (info?.stepSize) {
      return parseFloat(info.stepSize)
    }
    return 0.01 // fallback
  }

  /**
   * Max leverage permitted for `notionalUsd` on `symbol`, walked from the
   * cached bracket tiers (`/fapi/v1/leverageBracket`). Tiers are ordered
   * highest-leverage/smallest-notional first.
   *
   * Returns `null` if brackets aren't loaded (caller should fall back to the
   * flat `maxLeverage` cached on `AsterSymbolInfo`).
   */
  getMaxLeverageForNotional(symbol: string, notionalUsd: number): number | null {
    const asterSymbol = normalizeAsterSymbol(symbol)
    const info = this.client.getSymbolInfo(asterSymbol)
    if (!info?.brackets || info.brackets.length === 0) return null

    for (const b of info.brackets) {
      if (notionalUsd >= b.notionalFloor && notionalUsd < b.notionalCap) {
        return b.initialLeverage
      }
    }
    return info.brackets[info.brackets.length - 1].initialLeverage
  }

  /**
   * Flat per-symbol max leverage (smallest-notional bracket's `initialLeverage`).
   */
  getMaxLeverage(symbol: string): number | null {
    const asterSymbol = normalizeAsterSymbol(symbol)
    const info = this.client.getSymbolInfo(asterSymbol)
    return info?.maxLeverage ?? null
  }

  /**
   * Effective max-notional check for a new order on `symbol` at `leverage`.
   *
   * Aster caps **total** symbol position notional (existing + new) at a value
   * that depends on the *current* leverage setting. We get the authoritative
   * number by calling `POST /fapi/v1/leverage` — it returns `maxNotionalValue`
   * for the leverage we just set. Setting leverage is idempotent, so running
   * this during preflight is safe.
   *
   * Returns `{ maxNotional, existingNotional, headroom }` or `null` if the
   * API call fails (caller decides whether to block or warn).
   */
  async getEffectiveMaxNotional(
    symbol: string,
    leverage: number,
  ): Promise<{ maxNotional: number; existingNotional: number; headroom: number } | null> {
    if (!this.client.hasCredentials()) return null
    const asterSymbol = normalizeAsterSymbol(symbol)

    try {
      const [leverageResp, risks] = await Promise.all([
        this.client.setLeverage(asterSymbol, leverage),
        this.client.getPositionRisk(asterSymbol),
      ])
      const maxNotional = parseFloat(leverageResp.maxNotionalValue)
      if (!Number.isFinite(maxNotional) || maxNotional <= 0) return null

      // Sum absolute notional across all position sides (hedge mode may have both).
      let existingNotional = 0
      for (const r of risks) {
        if (r.symbol !== asterSymbol) continue
        const n = Math.abs(parseFloat(r.notional || '0'))
        if (Number.isFinite(n)) existingNotional += n
      }
      return {
        maxNotional,
        existingNotional,
        headroom: Math.max(0, maxNotional - existingNotional),
      }
    } catch (error) {
      log.warn(`[aster-arb] getEffectiveMaxNotional failed for ${asterSymbol}:`, error instanceof Error ? error.message : error)
      return null
    }
  }

  /**
   * Get historical funding payments for this user.
   * Pages through income history using time-based pagination.
   */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPaymentsResult> {
    if (!this.isInitialized || !this.client.hasCredentials()) return { payments: [], truncated: false }

    try {
      const payments: { symbol: string; amount: number; rate: number; timestamp: number }[] = []
      const limit = 1000
      let currentStart = startTime
      let hasMore = true
      let pages = 0
      const MAX_PAGES = 50

      while (hasMore && pages < MAX_PAGES) {
        pages++
        const params: { incomeType: string; startTime?: number; endTime?: number; limit: number } = {
          incomeType: 'FUNDING_FEE',
          limit,
        }
        if (currentStart) params.startTime = currentStart
        if (endTime) params.endTime = endTime

        const entries = await this.client.getIncome(params)

        for (const entry of entries) {
          payments.push({
            symbol: baseFromAsterSymbol(entry.symbol),
            amount: parseFloat(entry.income),
            rate: 0,
            timestamp: entry.time,
          })
        }

        if (entries.length === limit) {
          currentStart = entries[entries.length - 1].time + 1
        } else {
          hasMore = false
        }
      }

      const truncated = pages >= MAX_PAGES && hasMore
      return { payments, truncated }
    } catch (error) {
      log.error('[aster-arb] Error fetching funding payments:', error)
      throw error
    }
  }

  async cleanup(): Promise<void> {
    this.isInitialized = false
    this.symbolMap.clear()
    this.fundingIntervalMap.clear()
  }
}

export function createAsterArbProvider(): AsterArbProvider {
  return new AsterArbProvider()
}
