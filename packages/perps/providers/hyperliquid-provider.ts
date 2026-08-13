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
  GetPositionsOptions,
} from '../types'
import {
  HyperliquidClient,
  formatHyperliquidPrice,
  formatHyperliquidSize,
  createHyperliquidClient,
} from '../clients/hyperliquid-client'
import type {
  HyperliquidMeta,
  HyperliquidClearinghouseState,
  HyperliquidSignature,
  EIP712TypedData,
  SignTypedDataFn,
  HyperliquidAssetCtx,
  HyperliquidFrontendOpenOrder,
} from '../clients/hyperliquid-client'
import type { LocalAccount } from 'viem'
import { log } from '../logger'

/**
 * Hyperliquid market info with asset index
 */
interface HyperliquidMarketInfo extends ArbMarketInfo {
  assetIndex: number
  szDecimals: number
  maxLeverage: number
}

/**
 * Predicted funding info for a single coin (from HlPerp venue)
 */
interface PredictedFundingInfo {
  nextFundingTime: number
  fundingIntervalHours: number
}

/**
 * Cached market data
 */
interface MarketCache {
  meta: HyperliquidMeta | null
  mids: Record<string, string>
  assetCtxs: HyperliquidAssetCtx[] // Current funding rates, OI, etc.
  predictedFundings: Map<string, PredictedFundingInfo> // coin → predicted funding info
  timestamp: number
}

/**
 * Hyperliquid exchange provider for arbitrage trading
 * Implements IArbProvider interface for perpetual trading on Hyperliquid
 *
 * Note: Hyperliquid uses REST API with EIP-712 signing (not on-chain transactions),
 * similar to Pacifica. Trading requires an Ethereum wallet for signing.
 */
export class HyperliquidArbProvider implements IArbProvider {
  name = 'hyperliquid'

  protected ethAddress: string
  protected client: HyperliquidClient
  protected isInitialized = false

  // Market data cache
  protected marketCache: MarketCache = {
    meta: null,
    mids: {},
    assetCtxs: [],
    predictedFundings: new Map(),
    timestamp: 0,
  }
  protected readonly CACHE_TTL_MS = 5_000 // 5 seconds for price data

  // Asset name -> index mapping
  protected assetIndexMap: Map<string, number> = new Map()
  // Asset index -> metadata mapping
  protected assetMetaMap: Map<number, { szDecimals: number; maxLeverage: number }> = new Map()

  constructor(ethAddress: string, testnet: boolean = false) {
    this.ethAddress = ethAddress.toLowerCase()
    this.client = createHyperliquidClient(ethAddress, testnet)
  }

  /**
   * Set the viem account for signing trading operations
   * Must be called before any trading operations
   * The account should be created via Privy's createViemAccount
   */
  setViemAccount(account: LocalAccount): void {
    this.client.setViemAccount(account)
  }

  /**
   * @deprecated Use setViemAccount instead
   */
  setSignTypedData(signFn: SignTypedDataFn): void {
    log.warn('[hl-arb] setSignTypedData is deprecated, use setViemAccount instead')
    // No-op - kept for backward compatibility
  }

  /**
   * Initialize the provider
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return

    try {
      // Fetch initial market data
      await this.refreshMarketData()

      this.isInitialized = true
      log.info(`[hl-arb] Provider initialized with ${this.assetIndexMap.size} markets`)
    } catch (error) {
      log.error('[hl-arb] Failed to initialize:', error)
      throw error
    }
  }

  /**
   * Refresh market data (meta, prices, and funding rates)
   */
  protected async refreshMarketData(): Promise<void> {
    const now = Date.now()

    // Skip if cache is still valid
    if (this.marketCache.timestamp > 0 && (now - this.marketCache.timestamp) < this.CACHE_TTL_MS) {
      return
    }

    try {
      // Fetch meta with asset contexts, mids, and predicted fundings in parallel
      const [[meta, assetCtxs], mids, predictedFundingsRaw] = await Promise.all([
        this.client.getMetaAndAssetCtxs(),
        this.client.getAllMids(),
        this.client.getPredictedFundings().catch(() => [] as Awaited<ReturnType<typeof this.client.getPredictedFundings>>),
      ])

      // Update asset mappings
      this.assetIndexMap.clear()
      this.assetMetaMap.clear()

      for (let i = 0; i < meta.universe.length; i++) {
        const asset = meta.universe[i]
        this.assetIndexMap.set(asset.name.toUpperCase(), i)
        this.assetMetaMap.set(i, {
          szDecimals: asset.szDecimals,
          maxLeverage: asset.maxLeverage,
        })
      }

      // Parse predicted fundings — extract HlPerp venue data per coin
      // Advance nextFundingTime forward if the API returned a stale (past) timestamp
      const predictedFundings = new Map<string, PredictedFundingInfo>()
      for (const [coin, venues] of predictedFundingsRaw) {
        for (const [venue, data] of venues) {
          if (venue === 'HlPerp' && data) {
            const intervalMs = data.fundingIntervalHours * 3_600_000
            let nft = data.nextFundingTime
            while (nft <= now) nft += intervalMs
            predictedFundings.set(coin.toUpperCase(), {
              nextFundingTime: nft,
              fundingIntervalHours: data.fundingIntervalHours,
            })
            break
          }
        }
      }

      this.marketCache = {
        meta,
        mids,
        assetCtxs,
        predictedFundings,
        timestamp: now,
      }
    } catch (error) {
      log.error('[hl-arb] Error refreshing market data:', error)
      // Don't throw - use cached data if available
    }
  }

  /**
   * Normalize symbol to Hyperliquid format
   * Hyperliquid uses: BTC, ETH, SOL, etc. (no suffix)
   */
  protected normalizeSymbol(symbol: string): string {
    const upper = symbol.toUpperCase()
    // Remove common suffixes
    return upper.replace(/-PERP$/, '').replace(/-USD$/, '')
  }

  /**
   * Get asset index for a symbol
   */
  protected getAssetIndex(symbol: string): number | null {
    const normalized = this.normalizeSymbol(symbol)
    return this.assetIndexMap.get(normalized) ?? null
  }

  /**
   * Get asset metadata
   */
  protected getAssetMeta(assetIndex: number): { szDecimals: number; maxLeverage: number } | null {
    return this.assetMetaMap.get(assetIndex) ?? null
  }

  /**
   * Get szDecimals for a market symbol (lot size precision)
   */
  getSzDecimals(symbol: string): number | null {
    const assetIndex = this.getAssetIndex(symbol)
    if (assetIndex === null) return null
    const meta = this.getAssetMeta(assetIndex)
    return meta?.szDecimals ?? null
  }

  /**
   * Get market info for a specific symbol
   */
  async getMarketInfo(symbol: string): Promise<ArbMarketInfo | null> {
    if (!this.isInitialized) {
      throw new Error('Hyperliquid provider not initialized')
    }

    await this.refreshMarketData()

    const normalized = this.normalizeSymbol(symbol)
    const assetIndex = this.assetIndexMap.get(normalized)

    if (assetIndex === undefined) {
      return null
    }

    const priceStr = this.marketCache.mids[normalized]
    if (!priceStr) {
      return null
    }

    const oraclePrice = parseFloat(priceStr)
    const assetMeta = this.assetMetaMap.get(assetIndex)

    // Get funding rate from cached asset context
    let fundingRate: number | undefined
    let fundingRateApr: number | undefined
    const assetCtx = this.marketCache.assetCtxs[assetIndex]
    const predicted = this.marketCache.predictedFundings.get(normalized)

    if (assetCtx?.funding) {
      fundingRate = parseFloat(assetCtx.funding)
      const intervalHours = predicted?.fundingIntervalHours ?? 1
      fundingRateApr = fundingRate * (24 / intervalHours) * 365
    }

    const markPrice = assetCtx?.markPx ? parseFloat(assetCtx.markPx) : undefined
    const indexPrice = assetCtx?.oraclePx ? parseFloat(assetCtx.oraclePx) : undefined

    return {
      symbol: normalized,
      oraclePrice,
      markPrice,
      indexPrice,
      fundingRate,
      fundingRateApr,
      openInterest: undefined,
      fundingIntervalHours: predicted?.fundingIntervalHours ?? 1,
      nextFundingTime: predicted?.nextFundingTime,
    } as HyperliquidMarketInfo
  }

  /**
   * Get all available markets
   */
  async getAllMarkets(): Promise<ArbMarketInfo[]> {
    if (!this.isInitialized) {
      throw new Error('Hyperliquid provider not initialized')
    }

    await this.refreshMarketData()

    const markets: ArbMarketInfo[] = []

    if (!this.marketCache.meta) {
      return markets
    }

    for (let i = 0; i < this.marketCache.meta.universe.length; i++) {
      const asset = this.marketCache.meta.universe[i]
      const priceStr = this.marketCache.mids[asset.name]
      const assetCtx = this.marketCache.assetCtxs[i]

      if (!priceStr) continue

      const oraclePrice = parseFloat(priceStr)

      let fundingRate: number | undefined
      let fundingRateApr: number | undefined
      let openInterest: { long: number; short: number } | undefined
      const predicted = this.marketCache.predictedFundings.get(asset.name.toUpperCase())

      if (assetCtx?.funding) {
        fundingRate = parseFloat(assetCtx.funding)
        const intervalHours = predicted?.fundingIntervalHours ?? 1
        fundingRateApr = fundingRate * (24 / intervalHours) * 365
      }

      if (assetCtx?.openInterest) {
        const totalOiNative = parseFloat(assetCtx.openInterest)
        const totalOiUsd = totalOiNative * oraclePrice
        openInterest = { long: totalOiUsd, short: 0 }
      }

      const meta = this.getAssetMeta(i)
      const markPrice = assetCtx?.markPx ? parseFloat(assetCtx.markPx) : undefined
      const indexPrice = assetCtx?.oraclePx ? parseFloat(assetCtx.oraclePx) : undefined

      markets.push({
        symbol: asset.name.toUpperCase(),
        oraclePrice,
        markPrice,
        indexPrice,
        fundingRate,
        fundingRateApr,
        openInterest,
        maxLeverage: meta?.maxLeverage,
        fundingIntervalHours: predicted?.fundingIntervalHours ?? 1,
        nextFundingTime: predicted?.nextFundingTime,
      })
    }

    return markets
  }

  /**
   * Get fee structure for a market
   * Hyperliquid fees: 0.035% taker, 0.01% maker (can vary by VIP tier)
   */
  async getFees(symbol: string): Promise<ArbFeeInfo> {
    // Standard Hyperliquid fees
    return {
      takerFeeBps: 3.5, // 0.035%
      makerFeeBps: 1.0, // 0.01%
    }
  }

  /**
   * Build transaction to open a position
   *
   * Note: Hyperliquid uses REST API, not on-chain transactions.
   * This method creates a placeholder transaction. Use executeOpenPosition() for actual trading.
   */
  async buildOpenPositionTransaction(
    params: OpenPositionParams,
    wallet: PublicKey
  ): Promise<OpenPositionResult> {
    await this.refreshMarketData()

    const normalized = this.normalizeSymbol(params.symbol)
    const assetIndex = this.getAssetIndex(params.symbol)

    if (assetIndex === null) {
      throw new Error(`Market ${params.symbol} not found on Hyperliquid`)
    }

    const priceStr = this.marketCache.mids[normalized]
    if (!priceStr) {
      throw new Error(`Price not available for ${params.symbol} on Hyperliquid`)
    }

    const oraclePrice = parseFloat(priceStr)
    const notionalUsd = params.marginUsd * params.leverage
    const sizeAsset = notionalUsd / oraclePrice

    // Calculate estimated fees (taker fee for market orders)
    const fees = await this.getFees(params.symbol)
    const estimatedFees = notionalUsd * (fees.takerFeeBps || 3.5) / 10000

    // Return placeholder result
    return {
      transaction: new Transaction(), // Empty placeholder
      direction: params.direction,
      notionalUsd,
      marginUsd: params.marginUsd,
      estimatedFees,
      oraclePrice,
      entryPrice: oraclePrice,
      additionalSigners: [],
      addressLookupTables: [],
    }
  }

  /**
   * Build transaction to close a position
   *
   * Note: Hyperliquid uses REST API, not on-chain transactions.
   */
  async buildClosePositionTransaction(
    symbol: string,
    direction: 'long' | 'short',
    wallet: PublicKey
  ): Promise<ClosePositionResult> {
    return {
      transaction: new Transaction(), // Empty placeholder
      direction,
      symbol: this.normalizeSymbol(symbol),
    }
  }

  /**
   * Execute a trade on Hyperliquid via REST API
   * This is the actual trading method for Hyperliquid
   */
  async executeTrade(
    params: OpenPositionParams
  ): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
    const normalized = this.normalizeSymbol(params.symbol)
    const assetIndex = this.getAssetIndex(params.symbol)

    if (assetIndex === null) {
      throw new Error(`Market ${params.symbol} not found on Hyperliquid`)
    }

    const assetMeta = this.getAssetMeta(assetIndex)
    if (!assetMeta) {
      throw new Error(`Asset metadata not found for ${params.symbol}`)
    }

    // First, set leverage for this asset
    log.info(`[hl-arb] Setting leverage: ${params.leverage}x for ${normalized}`)
    await this.client.updateLeverage(assetIndex, params.leverage, false) // isolated margin

    // Refresh prices
    await this.refreshMarketData()

    const priceStr = this.marketCache.mids[normalized]
    if (!priceStr) {
      throw new Error(`Price not available for ${normalized}`)
    }

    const currentPrice = parseFloat(priceStr)
    const sizeAsset = params.sizeAsset ?? (params.marginUsd * params.leverage) / currentPrice

    // Format size according to asset decimals
    const formattedSize = formatHyperliquidSize(sizeAsset, assetMeta.szDecimals)

    log.info(`[hl-arb] Executing ${params.direction} order: ${formattedSize} ${normalized} @ market (szDecimals=${assetMeta.szDecimals})`)

    // Place market order (pass szDecimals for proper price formatting)
    const result = await this.client.placeMarketOrder(
      assetIndex,
      params.direction === 'long',
      formattedSize,
      currentPrice,
      assetMeta.szDecimals,
      1.0 // 1% slippage
    )

    if (result.status !== 'ok') {
      throw new Error(`Hyperliquid order failed: ${JSON.stringify(result)}`)
    }

    // Extract order details from response
    const orderStatus = result.response?.data?.statuses?.[0]
    if (orderStatus?.error) {
      throw new Error(`Hyperliquid order error: ${orderStatus.error}`)
    }

    const filled = orderStatus?.filled
    const resting = orderStatus?.resting

    return {
      orderId: filled?.oid || resting?.oid || 0,
      success: true,
      avgPrice: filled?.avgPx,
    }
  }

  /**
   * Close a position on Hyperliquid via REST API
   */
  async executeClose(
    symbol: string,
    direction: 'long' | 'short'
  ): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
    const normalized = this.normalizeSymbol(symbol)
    const assetIndex = this.getAssetIndex(symbol)

    if (assetIndex === null) {
      throw new Error(`Market ${symbol} not found on Hyperliquid`)
    }

    // Get current position to determine size
    const positions = await this.getPositions(new PublicKey('11111111111111111111111111111111')) // dummy key
    const position = positions.find(
      p => p.symbol.toUpperCase() === normalized && p.direction === direction
    )

    if (!position) {
      throw new Error(`No ${direction} position found for ${normalized}`)
    }

    const assetMeta = this.getAssetMeta(assetIndex)
    if (!assetMeta) {
      throw new Error(`Asset metadata not found for ${symbol}`)
    }

    // Refresh prices
    await this.refreshMarketData()

    const priceStr = this.marketCache.mids[normalized]
    if (!priceStr) {
      throw new Error(`Price not available for ${normalized}`)
    }

    const currentPrice = parseFloat(priceStr)
    const formattedSize = formatHyperliquidSize(Math.abs(position.sizeAsset), assetMeta.szDecimals)

    log.info(`[hl-arb] Closing ${direction} position: ${formattedSize} ${normalized} (szDecimals=${assetMeta.szDecimals})`)

    // Close by placing opposite direction order with reduce-only
    // For IOC market order, we need to set a price with slippage
    const slippageMultiplier = direction === 'long' ? 0.99 : 1.01 // Opposite direction
    const limitPrice = currentPrice * slippageMultiplier
    const formattedPrice = formatHyperliquidPrice(limitPrice, assetMeta.szDecimals)

    log.info(`[hl-arb] Close order price: raw=${limitPrice}, formatted=${formattedPrice}`)

    const result = await this.client.placeOrder({
      asset: assetIndex,
      isBuy: direction === 'short', // Opposite to close
      limitPx: formattedPrice,
      sz: formattedSize,
      reduceOnly: true,
      orderType: { limit: { tif: 'Ioc' } },
    })

    if (result.status !== 'ok') {
      throw new Error(`Hyperliquid close order failed: ${JSON.stringify(result)}`)
    }

    const orderStatus = result.response?.data?.statuses?.[0]
    if (orderStatus?.error) {
      throw new Error(`Hyperliquid close order error: ${orderStatus.error}`)
    }

    const filled = orderStatus?.filled
    const resting = orderStatus?.resting

    return {
      orderId: filled?.oid || resting?.oid || 0,
      success: true,
      avgPrice: filled?.avgPx,
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
   * Uses positionTpsl grouping so the trigger adjusts with position size.
   */
  private async _setTriggerOrder(
    type: 'tp' | 'sl',
    symbol: string,
    triggerPrice: number,
  ): Promise<{ success: boolean; direction: 'long' | 'short' }> {
    const label = type.toUpperCase()
    const normalized = this.normalizeSymbol(symbol)
    const assetIndex = this.getAssetIndex(symbol)
    if (assetIndex === null) {
      throw new Error(`Market ${symbol} not found on Hyperliquid`)
    }

    // Hyperliquid does not use the Solana wallet for auth; pass system-program placeholder.
    const positions = await this.getPositions(new PublicKey('11111111111111111111111111111111'))
    const position = positions.find(p => p.symbol.toUpperCase() === normalized)
    if (!position) {
      throw new Error(`No position found for ${normalized} on Hyperliquid`)
    }

    const assetMeta = this.getAssetMeta(assetIndex)
    if (!assetMeta) {
      throw new Error(`Asset metadata not found for ${symbol}`)
    }

    const formattedSize = formatHyperliquidSize(Math.abs(position.sizeAsset), assetMeta.szDecimals)
    const formattedTriggerPx = formatHyperliquidPrice(triggerPrice, assetMeta.szDecimals)

    log.info(`[hl-arb] Setting ${label} on ${position.direction} ${normalized}: triggerPx=${formattedTriggerPx}, size=${formattedSize}`)

    const result = await this.client.placeOrder({
      asset: assetIndex,
      isBuy: position.direction === 'short', // opposite direction to close
      limitPx: formattedTriggerPx,
      sz: formattedSize,
      reduceOnly: true,
      orderType: {
        trigger: {
          triggerPx: formattedTriggerPx,
          isMarket: true,
          tpsl: type,
        },
      },
    }, 'positionTpsl')

    if (result.status !== 'ok') {
      throw new Error(`Hyperliquid ${label} order failed: ${JSON.stringify(result)}`)
    }

    const orderStatus = result.response?.data?.statuses?.[0]
    // 'waitingForTrigger' is a success status for trigger orders — the order is set and pending
    if (orderStatus?.error && orderStatus.error !== 'waitingForTrigger') {
      throw new Error(`Hyperliquid ${label} error: ${orderStatus.error}`)
    }

    return { success: true, direction: position.direction }
  }

  /**
   * Get user's open positions
   */
  async getPositions(wallet: PublicKey, options?: GetPositionsOptions): Promise<ArbPosition[]> {
    if (!this.isInitialized) {
      return []
    }

    try {
      const includeTriggerPrices = options?.includeTriggerPrices !== false
      const statePromise = this.client.getClearinghouseState()
      const openOrdersPromise = includeTriggerPrices
        ? this.client.getFrontendOpenOrders().catch(err => {
            log.warn('[hl-arb] Failed to fetch open orders for TP/SL:', err instanceof Error ? err.message : err)
            return []
          })
        : Promise.resolve([])
      const [state, openOrders] = await Promise.all([statePromise, openOrdersPromise])
      const triggerMap = includeTriggerPrices ? buildTriggerMap(openOrders) : new Map<string, { tp?: number; sl?: number }>()

      const positions: ArbPosition[] = []

      for (const assetPos of state.assetPositions) {
        const pos = assetPos.position
        const szi = parseFloat(pos.szi)

        // Skip zero positions
        if (szi === 0) continue

        const direction: 'long' | 'short' = szi > 0 ? 'long' : 'short'
        const sizeAsset = Math.abs(szi)
        const entryPrice = parseFloat(pos.entryPx)
        const sizeUsd = parseFloat(pos.positionValue)
        const pricePnl = parseFloat(pos.unrealizedPnl)
        // cumFunding.sinceOpen is funding *paid* (positive = cost), negate for income
        const fundingSinceOpen = parseFloat(pos.cumFunding?.sinceOpen || '0')
        const fundingIncome = -fundingSinceOpen
        const pnl = pricePnl + fundingIncome
        const margin = parseFloat(pos.marginUsed)
        const leverage = pos.leverage?.value || (margin > 0 ? sizeUsd / margin : 1)

        const liquidationPrice = pos.liquidationPx ? parseFloat(pos.liquidationPx) : undefined

        const symbol = pos.coin.toUpperCase()
        const triggerPrices = triggerMap.get(`${pos.coin}:${direction}`)

        positions.push({
          symbol,
          direction,
          sizeUsd,
          sizeAsset,
          pnl,
          unrealizedPnl: pricePnl,
          fundingIncome,
          entryPrice,
          leverage,
          margin,
          liquidationPrice,
          triggerPrices,
        })
      }

      return positions
    } catch (error) {
      log.error('[hl-arb] Error fetching positions:', error)
      return []
    }
  }

  /**
   * Get account info (balance, margin, etc.)
   */
  async getAccountInfo(): Promise<{
    accountValue: number
    totalMarginUsed: number
    withdrawable: number
  } | null> {
    try {
      const state = await this.client.getClearinghouseState()

      return {
        accountValue: parseFloat(state.crossMarginSummary.accountValue),
        totalMarginUsed: parseFloat(state.crossMarginSummary.totalMarginUsed),
        withdrawable: parseFloat(state.withdrawable),
      }
    } catch (error) {
      log.error('[hl-arb] Error fetching account info:', error)
      return null
    }
  }

  /**
   * Get historical funding payments for this user
   */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPaymentsResult> {
    if (!this.isInitialized) return { payments: [], truncated: false }

    try {
      const entries = await this.client.getUserFunding(
        undefined,
        startTime,
        endTime,
      )

      const payments = entries.map(entry => ({
        symbol: entry.delta.coin.toUpperCase(),
        amount: parseFloat(entry.delta.usdc),
        rate: parseFloat(entry.delta.fundingRate),
        timestamp: entry.time,
        direction: parseFloat(entry.delta.szi) > 0 ? 'long' as const : 'short' as const,
      }))

      return { payments, truncated: false }
    } catch (error) {
      log.error('[hl-arb] Error fetching funding payments:', error)
      throw error
    }
  }

  /**
   * Cleanup and reset
   */
  async cleanup(): Promise<void> {
    this.assetIndexMap.clear()
    this.assetMetaMap.clear()
    this.marketCache = { meta: null, mids: {}, assetCtxs: [], predictedFundings: new Map(), timestamp: 0 }
    this.isInitialized = false
  }
}

/**
 * Create a Hyperliquid provider instance
 * Note: ethAddress is required for Hyperliquid (uses Ethereum wallet)
 */
export function createHyperliquidArbProvider(
  ethAddress: string,
  testnet: boolean = false
): HyperliquidArbProvider {
  return new HyperliquidArbProvider(ethAddress, testnet)
}

/**
 * Normalize symbol to Hyperliquid format (exported for use in trade handlers)
 */
export function normalizeHyperliquidSymbol(symbol: string): string {
  const upper = symbol.toUpperCase()
  return upper.replace(/-PERP$/, '').replace(/-USD$/, '')
}

/**
 * `coin` is left as-returned so HIP-3's `<dex>:` prefix lines up with
 * `position.coin`. TP/SL on a long is a sell (side='A'); on a short, a buy.
 */
export function buildTriggerMap(
  orders: HyperliquidFrontendOpenOrder[]
): Map<string, { tp?: number; sl?: number }> {
  const map = new Map<string, { tp?: number; sl?: number }>()
  for (const order of orders) {
    if (!order.isTrigger || !order.reduceOnly) continue
    const orderType = (order.orderType || '').toLowerCase()
    const isTp = orderType.includes('take profit')
    const isSl = orderType.includes('stop')
    if (!isTp && !isSl) continue
    const triggerPx = parseFloat(order.triggerPx)
    if (!Number.isFinite(triggerPx) || triggerPx <= 0) continue

    const direction: 'long' | 'short' = order.side === 'A' ? 'long' : 'short'
    const key = `${order.coin}:${direction}`
    const entry = map.get(key) || {}
    if (isTp) entry.tp = triggerPx
    else entry.sl = triggerPx
    map.set(key, entry)
  }
  return map
}
