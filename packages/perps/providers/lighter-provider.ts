import { PublicKey, Transaction } from '@solana/web3.js'
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
import { LighterClient, createLighterClient } from '../clients/lighter-client'
import type { LighterOrderBookDetail, LighterMarketData, LighterActiveOrder } from '../clients/lighter-client'
import {
  createClient as ffiCreateClient,
  createAuthToken,
  signCreateOrder,
  signUpdateLeverage,
  type LighterCredentials,
} from '../lighter/signer'
import { log } from '../logger'
import { nextHourMs } from '../funding-rates/utils'

const LIGHTER_BASE_URL = 'https://mainnet.zklighter.elliot.ai'
const LIGHTER_CHAIN_ID = 304

// Lighter order type constants (from zklighter-sdk SignerClient)
const ORDER_TYPE_LIMIT = 0
const ORDER_TYPE_MARKET = 1
const ORDER_TYPE_STOP_LOSS = 2
const ORDER_TYPE_STOP_LOSS_LIMIT = 3
const ORDER_TYPE_TAKE_PROFIT = 4
const ORDER_TYPE_TAKE_PROFIT_LIMIT = 5

// Time in force constants
const TIF_IOC = 0
// const TIF_GTC = 1
// const TIF_POST_ONLY = 2

/**
 * Normalize symbol to Lighter format (uppercase base symbol)
 */
export function normalizeLighterSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/-PERP$/, '').replace(/-USD$/, '')
}

/**
 * Lighter DEX provider for arbitrage trading
 * Implements IArbProvider interface for perpetual trading on Lighter
 *
 * Lighter uses a custom REST API with zklighter-sdk for signing.
 * Zero-fee trading.
 *
 * Note: Full order execution requires zklighter-sdk SignerClient with
 * an API key stored in DB. This implementation handles market data and
 * position fetching, with order execution via the SDK.
 */
export class LighterArbProvider implements IArbProvider {
  name = 'lighter'

  private client: LighterClient
  private isInitialized = false
  private marketDataCache: LighterMarketData[] = []
  private marketDataTimestamp = 0
  private readonly CACHE_TTL_MS = 5_000
  private credentials: LighterCredentials | null = null
  private ethAddress: string | null = null

  constructor() {
    this.client = createLighterClient()
  }

  async setCredentials(creds: LighterCredentials): Promise<void> {
    this.credentials = creds
    // Initialize the FFI client with these credentials
    await ffiCreateClient(LIGHTER_BASE_URL, creds.apiPrivateKey, LIGHTER_CHAIN_ID, creds.apiKeyIndex, creds.accountIndex)
    log.info(`[lighter-arb] Credentials set (accountIndex=${creds.accountIndex})`)
  }

  setEthAddress(address: string): void {
    this.ethAddress = address
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return

    try {
      // Fetch order book metas → caches market info and symbol mapping
      await this.client.getOrderBookMetas()
      this.isInitialized = true
      log.info(`[lighter-arb] Provider initialized with ${this.client.getSymbolMap().size} markets`)
    } catch (error) {
      log.error('[lighter-arb] Failed to initialize:', error)
      throw error
    }
  }

  private async refreshMarketData(): Promise<void> {
    const now = Date.now()
    if (this.marketDataTimestamp > 0 && (now - this.marketDataTimestamp) < this.CACHE_TTL_MS) return

    try {
      this.marketDataCache = await this.client.getMarketData()
      this.marketDataTimestamp = now
    } catch (error) {
      log.error('[lighter-arb] Error refreshing market data:', error)
    }
  }

  async getMarketInfo(symbol: string): Promise<ArbMarketInfo | null> {
    if (!this.isInitialized) throw new Error('Lighter provider not initialized')

    const normalized = normalizeLighterSymbol(symbol)
    const marketIndex = this.client.getMarketIndex(normalized)
    if (marketIndex === undefined) return null

    await this.refreshMarketData()

    const marketData = this.marketDataCache.find(m => m.market_id === marketIndex)
    if (!marketData) return null

    const markPrice = parseFloat(marketData.mark_price)
    const fundingRate = parseFloat(marketData.funding_rate || '0')
    // Lighter API returns 1/8th of hourly premium (8h-equivalent rate); 3 periods/day
    const fundingRateApr = fundingRate * 3 * 365

    const oi = parseFloat(marketData.open_interest || '0')
    const oiUsd = oi * markPrice

    return {
      symbol: normalized,
      oraclePrice: markPrice,
      // No oracle on Lighter — last trade is the best mark we have.
      markPrice,
      fundingRate,
      fundingRateApr,
      openInterest: oiUsd > 0 ? { long: oiUsd, short: oiUsd } : undefined,
      fundingIntervalHours: 1,
      nextFundingTime: nextHourMs(),
    }
  }

  async getAllMarkets(): Promise<ArbMarketInfo[]> {
    if (!this.isInitialized) throw new Error('Lighter provider not initialized')

    await this.refreshMarketData()

    const markets: ArbMarketInfo[] = []
    const symbolMap = this.client.getSymbolMap()
    const reverseMap = new Map<number, string>()
    for (const [sym, idx] of symbolMap) {
      reverseMap.set(idx, sym)
    }

    const nextFundingTime = nextHourMs()

    for (const md of this.marketDataCache) {
      const symbol = reverseMap.get(md.market_id)
      if (!symbol) continue

      const markPrice = parseFloat(md.mark_price)
      if (markPrice <= 0) continue

      const fundingRate = parseFloat(md.funding_rate || '0')
      // Lighter API returns 1/8th of hourly premium (8h-equivalent rate); 3 periods/day
      const fundingRateApr = fundingRate * 3 * 365

      const oi = parseFloat(md.open_interest || '0')
      const oiUsd = oi * markPrice

      // Max leverage from min initial margin fraction (10000 / min_imf, same scale as signUpdateLeverage)
      const detail = this.client.getOrderBookDetail(md.market_id)
      const maxLeverage = detail && detail.min_initial_margin_fraction > 0
        ? Math.floor(10000 / detail.min_initial_margin_fraction)
        : undefined

      markets.push({
        symbol,
        oraclePrice: markPrice,
        markPrice,
        fundingRate,
        fundingRateApr,
        openInterest: oiUsd > 0 ? { long: oiUsd, short: oiUsd } : undefined,
        maxLeverage,
        fundingIntervalHours: 1,
        nextFundingTime,
      })
    }

    return markets
  }

  async getFees(symbol: string): Promise<ArbFeeInfo> {
    const normalized = normalizeLighterSymbol(symbol)
    const marketIndex = this.client.getMarketIndex(normalized)
    if (marketIndex !== undefined) {
      const detail = this.client.getOrderBookDetail(marketIndex)
      if (detail) {
        return {
          takerFeeBps: parseFloat(detail.taker_fee) * 10000,
          makerFeeBps: parseFloat(detail.maker_fee) * 10000,
        }
      }
    }
    return {
      takerFeeBps: 0,
      makerFeeBps: 0,
    }
  }

  async buildOpenPositionTransaction(
    params: OpenPositionParams,
    wallet: PublicKey
  ): Promise<OpenPositionResult> {
    const notionalUsd = params.marginUsd * params.leverage

    let oraclePrice = 0
    try {
      const info = await this.getMarketInfo(params.symbol)
      if (info) oraclePrice = info.oraclePrice
    } catch { /* use 0 */ }

    return {
      transaction: new Transaction(), // Placeholder — REST-based
      direction: params.direction,
      notionalUsd,
      marginUsd: params.marginUsd,
      estimatedFees: 0, // Zero fees
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
      symbol: normalizeLighterSymbol(symbol),
    }
  }

  /**
   * Execute a trade on Lighter via FFI signer + REST API
   * Requires credentials to be set via setCredentials()
   */
  async executeTrade(
    params: OpenPositionParams
  ): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
    if (!this.credentials) {
      throw new Error('Lighter credentials not set. Call setCredentials() first.')
    }

    const normalized = normalizeLighterSymbol(params.symbol)
    const marketIndex = this.client.getMarketIndex(normalized)
    if (marketIndex === undefined) {
      throw new Error(`Market ${params.symbol} not found on Lighter`)
    }

    // Get current price
    await this.refreshMarketData()
    const marketData = this.marketDataCache.find(m => m.market_id === marketIndex)
    if (!marketData) throw new Error(`No market data for ${normalized}`)

    const currentPrice = parseFloat(marketData.mark_price)
    let sizeAsset = params.sizeAsset ?? (params.marginUsd * params.leverage) / currentPrice

    const detail = this.client.getOrderBookDetail(marketIndex)
    const sizeDecimals = detail?.supported_size_decimals ?? 4
    const priceDecimals = detail?.supported_price_decimals ?? 2

    const { apiKeyIndex, accountIndex } = this.credentials

    // Reject if account doesn't have enough balance for the requested size
    if (this.ethAddress) {
      try {
        const account = await this.client.getAccountByL1Address(this.ethAddress)
        if (account) {
          const balance = parseFloat(account.balance || '0')
          const requiredMargin = (sizeAsset * currentPrice) / params.leverage
          if (requiredMargin > balance * 0.98) {
            throw new Error(
              `Insufficient Lighter balance: $${balance.toFixed(2)} available, ` +
              `$${requiredMargin.toFixed(2)} margin required for ${sizeAsset} ${params.symbol} at ${params.leverage}x`
            )
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Insufficient Lighter balance')) throw e
        log.warn(`[lighter-arb] Could not check account balance:`, e)
      }
    }

    // Step 1: Set leverage
    const initialMarginFraction = Math.floor(10000 / params.leverage)
    const leverageNonce = await this.client.getNextNonce(accountIndex, apiKeyIndex)
    const leverageTx = await signUpdateLeverage(
      marketIndex, initialMarginFraction, 0, // 0 = isolated margin mode
      leverageNonce, apiKeyIndex, accountIndex,
    )
    const leverageResult = await this.client.sendTx(leverageTx.txType, leverageTx.txInfo)
    log.info(`[lighter-arb] Set leverage: ${params.leverage}x (IMF=${initialMarginFraction}) result=${JSON.stringify(leverageResult)}`)

    // Step 2: Place market order
    const isAsk = params.direction === 'short'
    const slippage = params.direction === 'long' ? 1.01 : 0.99
    const limitPrice = currentPrice * slippage

    // Convert to integer amounts using supported decimals
    const baseAmount = Math.round(sizeAsset * Math.pow(10, sizeDecimals))
    const priceInt = Math.round(limitPrice * Math.pow(10, priceDecimals))

    const orderNonce = await this.client.getNextNonce(accountIndex, apiKeyIndex)
    const orderTx = await signCreateOrder({
      marketIndex,
      clientOrderIndex: 0,
      baseAmount,
      price: priceInt,
      isAsk,
      orderType: ORDER_TYPE_MARKET,
      timeInForce: TIF_IOC,
      reduceOnly: false,
      triggerPrice: 0,
      orderExpiry: 0,
      nonce: orderNonce,
      apiKeyIndex,
      accountIndex,
    })

    log.info(`[lighter-arb] Placing ${params.direction} market IOC: ${sizeAsset.toFixed(sizeDecimals)} ${normalized} @ ${limitPrice.toFixed(priceDecimals)} (base=${baseAmount}, price=${priceInt})`)

    const orderResult = await this.client.sendTx(orderTx.txType, orderTx.txInfo)
    log.info(`[lighter-arb] Order result: ${JSON.stringify(orderResult)}`)

    if (orderResult.error) {
      throw new Error(`Lighter order failed: ${orderResult.error}`)
    }

    return {
      orderId: 0,
      success: true,
      avgPrice: limitPrice.toFixed(priceDecimals),
    }
  }

  /**
   * Close a position on Lighter (reduce-only order in opposite direction)
   */
  async executeClose(
    symbol: string,
    direction: 'long' | 'short'
  ): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
    if (!this.credentials) {
      throw new Error('Lighter credentials not set. Call setCredentials() first.')
    }
    if (!this.ethAddress) {
      throw new Error('ETH address not set. Call setEthAddress() first.')
    }

    const normalized = normalizeLighterSymbol(symbol)
    const marketIndex = this.client.getMarketIndex(normalized)
    if (marketIndex === undefined) {
      throw new Error(`Market ${symbol} not found on Lighter`)
    }

    // Get position size
    const positions = await this.getPositionsByEthAddress(this.ethAddress)
    const position = positions.find(p => p.symbol.toUpperCase() === normalized.toUpperCase() && p.direction === direction)
    if (!position) {
      throw new Error(`No ${direction} position found for ${normalized} on Lighter`)
    }

    // Get current price
    await this.refreshMarketData()
    const marketData = this.marketDataCache.find(m => m.market_id === marketIndex)
    if (!marketData) throw new Error(`No market data for ${normalized}`)

    const currentPrice = parseFloat(marketData.mark_price)
    const detail = this.client.getOrderBookDetail(marketIndex)
    const sizeDecimals = detail?.supported_size_decimals ?? 4
    const priceDecimals = detail?.supported_price_decimals ?? 2

    const { apiKeyIndex, accountIndex } = this.credentials

    // Close: opposite direction, reduce-only
    const isAsk = direction === 'long' // closing long = sell (ask)
    const slippage = direction === 'long' ? 0.99 : 1.01
    const limitPrice = currentPrice * slippage

    const baseAmount = Math.round(position.sizeAsset * Math.pow(10, sizeDecimals))
    const priceInt = Math.round(limitPrice * Math.pow(10, priceDecimals))

    const orderNonce = await this.client.getNextNonce(accountIndex, apiKeyIndex)
    const orderTx = await signCreateOrder({
      marketIndex,
      clientOrderIndex: 0,
      baseAmount,
      price: priceInt,
      isAsk,
      orderType: ORDER_TYPE_MARKET,
      timeInForce: TIF_IOC,
      reduceOnly: true,
      triggerPrice: 0,
      orderExpiry: 0,
      nonce: orderNonce,
      apiKeyIndex,
      accountIndex,
    })

    log.info(`[lighter-arb] Closing ${direction} ${position.sizeAsset.toFixed(sizeDecimals)} ${normalized} @ ${limitPrice.toFixed(priceDecimals)} (reduce-only, market IOC)`)

    const orderResult = await this.client.sendTx(orderTx.txType, orderTx.txInfo)
    log.info(`[lighter-arb] Close result: ${JSON.stringify(orderResult)}`)

    if (orderResult.error) {
      throw new Error(`Lighter close failed: ${orderResult.error}`)
    }

    return {
      orderId: 0,
      success: true,
      avgPrice: limitPrice.toFixed(priceDecimals),
    }
  }

  async setStopLoss(symbol: string, triggerPrice: number) {
    return this._setTriggerOrder('sl', symbol, triggerPrice)
  }

  async setTakeProfit(symbol: string, triggerPrice: number) {
    return this._setTriggerOrder('tp', symbol, triggerPrice)
  }

  /**
   * Place a TP or SL trigger order on an existing position.
   * Uses IOC + orderExpiry=-1 (sentinel: Go signer resolves to 28 days).
   */
  private async _setTriggerOrder(
    type: 'tp' | 'sl',
    symbol: string,
    triggerPrice: number,
  ): Promise<{ success: boolean; direction: 'long' | 'short' }> {
    if (!this.credentials) {
      throw new Error('Lighter credentials not set. Call setCredentials() first.')
    }
    if (!this.ethAddress) {
      throw new Error('ETH address not set. Call setEthAddress() first.')
    }

    const label = type.toUpperCase()
    const normalized = normalizeLighterSymbol(symbol)
    const marketIndex = this.client.getMarketIndex(normalized)
    if (marketIndex === undefined) {
      throw new Error(`Market ${symbol} not found on Lighter`)
    }

    const positions = await this.getPositionsByEthAddress(this.ethAddress)
    const position = positions.find(p => p.symbol.toUpperCase() === normalized.toUpperCase())
    if (!position) {
      throw new Error(`No position found for ${normalized} on Lighter`)
    }

    await this.refreshMarketData()
    const detail = this.client.getOrderBookDetail(marketIndex)
    const sizeDecimals = detail?.supported_size_decimals ?? 4
    const priceDecimals = detail?.supported_price_decimals ?? 2

    const { apiKeyIndex, accountIndex } = this.credentials

    const isAsk = position.direction === 'long' // closing long = sell (ask)
    const baseAmount = Math.round(position.sizeAsset * Math.pow(10, sizeDecimals))
    const triggerPriceInt = Math.round(triggerPrice * Math.pow(10, priceDecimals))
    // Set limit price generously beyond trigger so a market-style fill goes through after trigger
    const slippage = position.direction === 'long' ? 0.95 : 1.05
    const priceInt = Math.round(triggerPrice * slippage * Math.pow(10, priceDecimals))

    const orderNonce = await this.client.getNextNonce(accountIndex, apiKeyIndex)
    const orderTx = await signCreateOrder({
      marketIndex,
      clientOrderIndex: 0,
      baseAmount,
      price: priceInt,
      isAsk,
      orderType: type === 'tp' ? ORDER_TYPE_TAKE_PROFIT : ORDER_TYPE_STOP_LOSS,
      timeInForce: TIF_IOC,
      reduceOnly: true,
      triggerPrice: triggerPriceInt,
      orderExpiry: -1,
      nonce: orderNonce,
      apiKeyIndex,
      accountIndex,
    })

    log.info(`[lighter-arb] Setting ${label} on ${position.direction} ${normalized}: triggerPrice=${triggerPrice}, size=${position.sizeAsset}`)

    const orderResult = await this.client.sendTx(orderTx.txType, orderTx.txInfo)
    log.info(`[lighter-arb] ${label} result: ${JSON.stringify(orderResult)}`)

    if (orderResult.error) {
      throw new Error(`Lighter ${label} order failed: ${orderResult.error}`)
    }

    return { success: true, direction: position.direction }
  }

  async getPositions(wallet: PublicKey, options?: { includeTriggerPrices?: boolean }): Promise<ArbPosition[]> {
    if (!this.isInitialized) return []
    if (!this.ethAddress) return []

    return this.getPositionsByEthAddress(this.ethAddress, options)
  }

  /**
   * Get available account balance in USD.
   */
  async getAccountBalance(): Promise<number | null> {
    if (!this.ethAddress) return null
    try {
      const account = await this.client.getAccountByL1Address(this.ethAddress)
      if (!account) return null
      return parseFloat(account.balance || '0')
    } catch {
      return null
    }
  }

  /**
   * Get positions by ETH address (Lighter native)
   * Uses /api/v1/account?by=l1_address which returns full position data.
   */
  async getPositionsByEthAddress(
    ethAddress: string,
    options?: { includeTriggerPrices?: boolean },
  ): Promise<ArbPosition[]> {
    try {
      const includeTriggerPrices = options?.includeTriggerPrices !== false
      // Auth-token mint depends only on credentials, so it can race the
      // account fetch instead of waiting on it.
      const creds = this.credentials
      const authTokenPromise = includeTriggerPrices && creds
        ? createAuthToken(Math.floor(Date.now() / 1000) + 600, creds.apiKeyIndex, creds.accountIndex)
            .catch(err => {
              log.warn('[lighter-arb] Failed to mint auth token for TP/SL:', err instanceof Error ? err.message : err)
              return null
            })
        : Promise.resolve(null)

      const account = await this.client.getDetailedAccountByL1Address(ethAddress)
      if (!account) return []

      const positionsData = account.positions || []
      if (positionsData.length === 0) return []

      let triggerMap = new Map<string, { tp?: number; sl?: number }>()
      const authToken = await authTokenPromise
      if (includeTriggerPrices && authToken) {
        try {
          const activeOrders = await this.client.getAccountActiveOrders(account.account_index, 255, authToken)
          const priceDecimalsByMarket = new Map<number, number>()
          for (const order of activeOrders) {
            if (priceDecimalsByMarket.has(order.market_index)) continue
            const detail = this.client.getOrderBookDetail(order.market_index)
            priceDecimalsByMarket.set(order.market_index, detail?.supported_price_decimals ?? 2)
          }
          triggerMap = buildLighterTriggerMap(activeOrders, priceDecimalsByMarket)
        } catch (err) {
          log.warn('[lighter-arb] Failed to fetch active orders for TP/SL:', err instanceof Error ? err.message : err)
        }
      }

      const positions: ArbPosition[] = []

      for (const pos of positionsData) {
        const size = parseFloat(pos.position)
        if (size === 0) continue

        const direction: 'long' | 'short' = pos.sign >= 0 ? 'long' : 'short'
        const sizeAsset = size // already absolute from API
        const entryPrice = parseFloat(pos.avg_entry_price)
        const positionValue = Math.abs(parseFloat(pos.position_value))
        const unrealizedPnl = parseFloat(pos.unrealized_pnl)
        const fundingPaidOut = parseFloat(pos.total_funding_paid_out || '0')
        const imf = parseFloat(pos.initial_margin_fraction)
        const leverage = imf > 0 ? 100 / imf : 1
        const allocatedMargin = parseFloat(pos.allocated_margin)
        // In cross mode (margin_mode=1), margin is roughly positionValue / leverage
        const margin = allocatedMargin > 0 ? allocatedMargin : positionValue / leverage
        const liquidationPrice = parseFloat(pos.liquidation_price)

        const triggerPrices = triggerMap.get(`${pos.market_id}:${direction}`)

        positions.push({
          symbol: pos.symbol,
          direction,
          sizeUsd: positionValue,
          sizeAsset,
          pnl: unrealizedPnl + fundingPaidOut,
          unrealizedPnl,
          fundingIncome: fundingPaidOut,
          entryPrice,
          leverage,
          margin,
          liquidationPrice: liquidationPrice > 0 ? liquidationPrice : undefined,
          triggerPrices,
        })
      }

      return positions
    } catch (error) {
      log.error('[lighter-arb] Error fetching positions by ETH address:', error)
      return []
    }
  }

  /**
   * Get lot size (step size) for a symbol
   */
  getLotSize(symbol: string): number {
    const normalized = normalizeLighterSymbol(symbol)
    const marketIndex = this.client.getMarketIndex(normalized)
    if (marketIndex === undefined) return 0.01

    const detail = this.client.getOrderBookDetail(marketIndex)
    if (detail) return Math.pow(10, -detail.supported_size_decimals)
    return 0.01
  }

  /**
   * Get historical funding payments for this user.
   * Exhausts cursor-based pagination to return complete history.
   */
  async getFundingPayments(startTime: number | undefined, endTime: number | undefined, authToken: string): Promise<FundingPaymentsResult> {
    if (!this.isInitialized) return { payments: [], truncated: false }

    let accountIndex: number | undefined = this.credentials?.accountIndex
    if (accountIndex === undefined && this.ethAddress) {
      const account = await this.client.getAccountByL1Address(this.ethAddress)
      if (!account) return { payments: [], truncated: false }
      accountIndex = account.account_index
    }
    if (accountIndex === undefined) return { payments: [], truncated: false }

    try {
      const symbolByMarketId = new Map<number, string>()
      for (const [symbol, mktId] of this.client.getSymbolMap()) {
        symbolByMarketId.set(mktId, symbol)
      }

      const payments: FundingPayment[] = []
      let cursor: string | undefined
      let hasMore = true
      let pages = 0
      const MAX_PAGES = 50

      while (hasMore && pages < MAX_PAGES) {
        pages++
        const data = await this.client.getPositionFunding(accountIndex, authToken, {
          limit: 100,
          cursor,
        })

        const entries = data.position_fundings || []
        if (entries.length === 0) break

        for (const entry of entries) {
          const tsMs = entry.timestamp * 1000
          if (startTime && tsMs < startTime) { hasMore = false; break }
          if (endTime && tsMs > endTime) continue

          const symbol = symbolByMarketId.get(entry.market_id) || `MKT-${entry.market_id}`

          payments.push({
            symbol: symbol.toUpperCase(),
            amount: parseFloat(entry.change),
            rate: parseFloat(entry.rate),
            timestamp: tsMs,
            direction: entry.position_side,
          })
        }

        cursor = data.next_cursor
        hasMore = hasMore && !!cursor
      }

      const truncated = pages >= MAX_PAGES && hasMore
      return { payments, truncated }
    } catch (error) {
      log.error('[lighter-arb] Error fetching funding payments:', error)
      throw error
    }
  }

  async cleanup(): Promise<void> {
    this.isInitialized = false
    this.marketDataCache = []
    this.marketDataTimestamp = 0
  }
}

export function createLighterArbProvider(): LighterArbProvider {
  return new LighterArbProvider()
}

const SL_NUMERIC_TYPES = new Set<number>([ORDER_TYPE_STOP_LOSS, ORDER_TYPE_STOP_LOSS_LIMIT])
const TP_NUMERIC_TYPES = new Set<number>([ORDER_TYPE_TAKE_PROFIT, ORDER_TYPE_TAKE_PROFIT_LIMIT])
const SL_STRING_TYPES = new Set(['stop-loss', 'stop-loss-limit', 'stop_loss', 'stop_loss_limit'])
const TP_STRING_TYPES = new Set(['take-profit', 'take-profit-limit', 'take_profit', 'take_profit_limit'])

/**
 * Lighter's accountActiveOrders returns orders with `type` as either a numeric
 * code (2/3/4/5) or a string ("stop-loss", "take-profit", and "-limit"
 * variants), and `trigger_price` as either an engine-scaled integer string or
 * a decimal string ("120.000"). Handle both shapes.
 */
export function buildLighterTriggerMap(
  orders: LighterActiveOrder[],
  priceDecimalsByMarket: Map<number, number>,
): Map<string, { tp?: number; sl?: number }> {
  const map = new Map<string, { tp?: number; sl?: number }>()
  for (const order of orders) {
    const t = order.type
    const tStr = typeof t === 'string' ? t.toLowerCase() : ''
    const isSl = (typeof t === 'number' && SL_NUMERIC_TYPES.has(t)) || SL_STRING_TYPES.has(tStr)
    const isTp = (typeof t === 'number' && TP_NUMERIC_TYPES.has(t)) || TP_STRING_TYPES.has(tStr)
    if (!isTp && !isSl) continue
    if (!order.trigger_price) continue

    const triggerPriceStr = String(order.trigger_price)
    // Decimal-string form ("120.000") is already in human price; integer-only
    // form is engine-scaled and needs dividing by 10^priceDecimals.
    const priceDecimals = priceDecimalsByMarket.get(order.market_index) ?? 2
    const triggerPx = triggerPriceStr.includes('.')
      ? parseFloat(triggerPriceStr)
      : parseFloat(triggerPriceStr) / Math.pow(10, priceDecimals)
    if (!Number.isFinite(triggerPx) || triggerPx <= 0) continue

    const isAsk = order.is_ask === true || order.is_ask === 1
    // TP/SL on a long closes via ASK (sell); on a short via BID (buy).
    const direction: 'long' | 'short' = isAsk ? 'long' : 'short'
    const key = `${order.market_index}:${direction}`
    const entry = map.get(key) || {}
    if (isTp) entry.tp = triggerPx
    else entry.sl = triggerPx
    map.set(key, entry)
  }
  return map
}
