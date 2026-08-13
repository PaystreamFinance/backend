import { PublicKey, Transaction } from '@solana/web3.js'
import * as bs58 from 'bs58'
import * as nacl from 'tweetnacl'
import dns from 'node:dns'
import { promisify } from 'node:util'
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
import { log } from '../logger'
import { nextHalfHourMs } from '../funding-rates/utils'

// Pacifica API - use IPv4 to avoid Bun's IPv6 issues with CloudFront
export const PACIFICA_HOST = 'api.pacifica.fi'
export const PACIFICA_API_BASE = `https://${PACIFICA_HOST}`
let PACIFICA_IPV4: string | null = null

// Resolve IPv4 address once at module load
const resolve4 = promisify(dns.resolve4)
resolve4(PACIFICA_HOST).then(addresses => {
  if (addresses.length > 0) {
    PACIFICA_IPV4 = addresses[0]
    log.info(`[pacifica-arb] Resolved ${PACIFICA_HOST} to IPv4: ${PACIFICA_IPV4}`)
  }
}).catch(() => {
  log.warn(`[pacifica-arb] Failed to resolve IPv4 for ${PACIFICA_HOST}, will use hostname`)
})

// Signature expiry window in milliseconds (30 seconds)
export const SIGNATURE_EXPIRY_WINDOW_MS = 30_000

/**
 * Get resolved IPv4 address for Pacifica API
 */
export function getPacificaIPv4(): string | null {
  return PACIFICA_IPV4
}

/**
 * Pacifica market info from API
 */
interface PacificaMarketSpec {
  symbol: string
  tick_size: string
  min_tick: string
  max_tick: string
  lot_size: string
  max_leverage: number
  isolated_only: boolean
  min_order_size: string
  max_order_size: string
  funding_rate: string
  next_funding_rate: string
  created_at: number
}

/**
 * Pacifica price data from API
 * Actual field names from https://api.pacifica.fi/api/v1/info/prices
 */
interface PacificaPriceData {
  symbol: string
  mark: string           // Mark price
  mid: string            // Mid price
  oracle: string         // Oracle price
  funding: string        // Current funding rate
  next_funding: string   // Next funding rate
  open_interest: string  // Total open interest (not split by side)
  volume_24h: string
  yesterday_price: string
  timestamp: number
}

/**
 * Pacifica position from API
 */
interface PacificaPosition {
  symbol: string
  side: 'bid' | 'ask'
  amount: string
  entry_price: string
  margin: string
  funding: string
  isolated: boolean
  created_at: number
  updated_at: number
  liquidation_price?: string
}

/**
 * Pacifica account info from API
 */
interface PacificaAccountInfo {
  balance: string
  equity: string
  available_margin: string
  used_margin: string
  unrealized_pnl: string
  fee_tier: number
}

/**
 * Helper to recursively sort object keys for consistent JSON serialization
 */
function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys)
  }
  const sorted: Record<string, any> = {}
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key])
  }
  return sorted
}

/**
 * Create an unsigned payload for Pacifica API (message to be signed)
 * Exported for use when signing via external service (e.g., Privy)
 *
 * The message to sign has data NESTED: { type, timestamp, expiry_window?, data: {...} }
 * The request body has data FLATTENED: { account, signature, timestamp, ...data }
 */
export function createPacificaPayload(
  type: string,
  data: Record<string, any>,
): { payload: Record<string, any>; message: string; timestamp: number } {
  const timestamp = Date.now()

  // Message to sign: data is NESTED under "data" key
  const messagePayload = {
    type,
    timestamp,
    expiry_window: SIGNATURE_EXPIRY_WINDOW_MS,
    data,  // Nested, not flattened
  }

  // Sort keys recursively and serialize to compact JSON
  const sortedPayload = sortObjectKeys(messagePayload)
  const message = JSON.stringify(sortedPayload)

  // Return both the original data (for request body) and the message to sign
  return { payload: data, message, timestamp }
}

/**
 * Create a signed request payload for Pacifica API
 */
function createSignedPayload(
  type: string,
  data: Record<string, any>,
  privateKey: Uint8Array
): { payload: Record<string, any>; signature: string; timestamp: number } {
  const { payload: fullPayload, message: jsonString, timestamp } = createPacificaPayload(type, data)

  // Sign the message
  const messageBytes = new TextEncoder().encode(jsonString)
  const signature = nacl.sign.detached(messageBytes, privateKey)
  const signatureBase58 = bs58.encode(signature)

  return {
    payload: fullPayload,
    signature: signatureBase58,
    timestamp,
  }
}

/**
 * Pacifica exchange provider for arbitrage trading
 * Implements IArbProvider interface for perpetual trading on Pacifica
 *
 * Note: Pacifica uses REST API (not on-chain transactions), so trading
 * requires signing API requests rather than blockchain transactions.
 */
export class PacificaArbProvider implements IArbProvider {
  name = 'pacifica'

  private walletPubkey: PublicKey
  private isInitialized = false
  private marketSpecs: Map<string, PacificaMarketSpec> = new Map()
  private priceCache: Map<string, PacificaPriceData> = new Map()
  private priceCacheTimestamp = 0
  private readonly PRICE_CACHE_TTL_MS = 2_000 // 2 seconds - keep fresh

  // Private key for signing (set via setPrivateKey method)
  private privateKey: Uint8Array | null = null

  constructor(walletPubkey: PublicKey) {
    this.walletPubkey = walletPubkey
  }

  /**
   * Set the private key for signing API requests
   * This must be called before trading operations
   */
  setPrivateKey(privateKey: Uint8Array): void {
    this.privateKey = privateKey
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return

    try {
      // Fetch market specifications
      await this.fetchMarketSpecs()

      this.isInitialized = true
      log.info(`[pacifica-arb] Provider initialized with ${this.marketSpecs.size} markets`)
    } catch (error) {
      log.error('[pacifica-arb] Failed to initialize:', error)
      throw error
    }
  }

  /**
   * Fetch with timeout helper using Promise.race
   * Uses IPv4 address directly to avoid Bun's IPv6 issues with CloudFront
   */
  private async fetchWithTimeout(url: string, timeoutMs: number, options?: RequestInit): Promise<Response> {
    // Replace hostname with IPv4 if available to avoid Bun IPv6 issues
    let finalUrl = url
    let headers = { ...(options?.headers || {}) } as Record<string, string>

    if (PACIFICA_IPV4 && url.includes(PACIFICA_HOST)) {
      finalUrl = url.replace(PACIFICA_HOST, PACIFICA_IPV4)
      headers['Host'] = PACIFICA_HOST
    }

    return Promise.race([
      fetch(finalUrl, { ...options, headers }),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error(`Fetch timeout after ${timeoutMs}ms: ${url}`)), timeoutMs)
      )
    ])
  }

  /**
   * Fetch market specifications from Pacifica API
   */
  private async fetchMarketSpecs(): Promise<void> {
    try {
      const response = await this.fetchWithTimeout(`${PACIFICA_API_BASE}/api/v1/info`, 5000)

      if (!response.ok) {
        throw new Error(`Failed to fetch markets: ${response.status}`)
      }

      const data = await response.json()
      // Pacifica returns market info directly or nested in data
      const markets = data.data || data.markets || data
      if (Array.isArray(markets)) {
        for (const market of markets) {
          if (market.symbol) {
            this.marketSpecs.set(market.symbol.toUpperCase(), market)
          }
        }
      }
    } catch (error) {
      log.error('[pacifica-arb] Error fetching market specs:', error)
      // Don't throw - we can still work with cached data
    }
  }

  /**
   * Fetch prices from Pacifica API
   */
  private async fetchPrices(): Promise<void> {
    const now = Date.now()

    // Return cached data if still valid
    if (this.priceCacheTimestamp > 0 && (now - this.priceCacheTimestamp) < this.PRICE_CACHE_TTL_MS) {
      return
    }

    try {
      const response = await this.fetchWithTimeout(`${PACIFICA_API_BASE}/api/v1/info/prices`, 5000)

      if (!response.ok) {
        throw new Error(`Failed to fetch prices: ${response.status}`)
      }

      const data = await response.json()
      // Pacifica returns prices directly or nested in data
      const prices = data.data || data.prices || data
      if (Array.isArray(prices)) {
        this.priceCache.clear()
        for (const price of prices) {
          if (price.symbol) {
            this.priceCache.set(price.symbol.toUpperCase(), price)
          }
        }
        this.priceCacheTimestamp = now
      }
    } catch (error) {
      log.error('[pacifica-arb] Error fetching prices:', error)
    }
  }

  /**
   * Get market info for a specific symbol
   */
  async getMarketInfo(symbol: string): Promise<ArbMarketInfo | null> {
    if (!this.isInitialized) {
      throw new Error('Pacifica provider not initialized')
    }

    await this.fetchPrices()

    const normalizedSymbol = this.normalizeSymbol(symbol)
    const priceData = this.priceCache.get(normalizedSymbol)

    if (!priceData) return null

    const mark = parseFloat(priceData.mark)
    const oracle = parseFloat(priceData.oracle)
    const oraclePrice = oracle || mark || 0
    const markPrice = mark || undefined
    const indexPrice = oracle || undefined
    const fundingRate = parseFloat(priceData.funding) || 0
    // Pacifica funding is hourly: APR = rate * 24 * 365
    const fundingRateApr = fundingRate * 24 * 365
    // Open interest is total USD value, not split by side
    const openInterestUsd = parseFloat(priceData.open_interest) * oraclePrice

    return {
      symbol: normalizedSymbol,
      fundingRate,
      fundingRateApr,
      openInterest: {
        long: openInterestUsd, // Total OI in USD (not split)
        short: 0,              // Not available separately
      },
      oraclePrice,
      markPrice,
      indexPrice,
      fundingIntervalHours: 1,
      nextFundingTime: nextHalfHourMs(),
    }
  }

  /**
   * Get all available markets
   */
  async getAllMarkets(): Promise<ArbMarketInfo[]> {
    if (!this.isInitialized) {
      throw new Error('Pacifica provider not initialized')
    }

    await this.fetchPrices()

    const markets: ArbMarketInfo[] = []

    const nextFunding = nextHalfHourMs()

    for (const entry of Array.from(this.priceCache.entries())) {
      const [symbol, priceData] = entry
      const mark = parseFloat(priceData.mark)
      const oracle = parseFloat(priceData.oracle)
      const oraclePrice = oracle || mark || 0
      const markPrice = mark || undefined
      const indexPrice = oracle || undefined
      const fundingRate = parseFloat(priceData.funding) || 0
      // Pacifica funding is hourly: APR = rate * 24 * 365
      const fundingRateApr = fundingRate * 24 * 365
      // Open interest is total USD value
      const openInterestUsd = parseFloat(priceData.open_interest) * oraclePrice

      markets.push({
        symbol,
        fundingRate,
        fundingRateApr,
        openInterest: {
          long: openInterestUsd, // Total OI in USD
          short: 0,              // Not available separately
        },
        oraclePrice,
        markPrice,
        indexPrice,
        maxLeverage: this.getMaxLeverage(symbol),
        fundingIntervalHours: 1,
        nextFundingTime: nextFunding,
      })
    }

    return markets
  }

  /**
   * Get fee structure for a market
   */
  async getFees(_symbol: string): Promise<ArbFeeInfo> {
    // Pacifica fee info is not in the market spec API — use defaults
    return {
      takerFeeBps: 5, // 0.05%
      makerFeeBps: 2.5, // 0.025%
    }
  }

  /**
   * Build transaction to open a position
   *
   * Note: Pacifica uses REST API, not on-chain transactions.
   * This method creates a placeholder transaction. Use executeOpenPosition() for actual trading.
   */
  async buildOpenPositionTransaction(
    params: OpenPositionParams,
    wallet: PublicKey
  ): Promise<OpenPositionResult> {
    // For Pacifica, we don't build a blockchain transaction
    // Instead, we prepare the API request data
    // The actual execution happens via REST API

    const normalizedSymbol = this.normalizeSymbol(params.symbol)
    await this.fetchPrices()

    const priceData = this.priceCache.get(normalizedSymbol)
    if (!priceData) {
      throw new Error(`Market ${params.symbol} not found on Pacifica`)
    }

    const oraclePrice = parseFloat(priceData.mark)
    const notionalUsd = params.marginUsd * params.leverage
    const sizeAsset = notionalUsd / oraclePrice

    // Calculate estimated fees
    const fees = await this.getFees(params.symbol)
    const estimatedFees = notionalUsd * (fees.takerFeeBps || 5) / 10000

    // Return a placeholder result
    // The actual trade will be executed via executePacificaTrade()
    return {
      transaction: new Transaction(), // Empty placeholder
      direction: params.direction,
      notionalUsd,
      marginUsd: params.marginUsd,
      estimatedFees,
      oraclePrice,
      entryPrice: oraclePrice,
      // Mark this as Pacifica for special handling
      additionalSigners: [],
      addressLookupTables: [],
    }
  }

  /**
   * Build transaction to close a position
   *
   * Note: Pacifica uses REST API, not on-chain transactions.
   */
  async buildClosePositionTransaction(
    symbol: string,
    direction: 'long' | 'short',
    wallet: PublicKey
  ): Promise<ClosePositionResult> {
    // Placeholder - actual closing happens via REST API
    return {
      transaction: new Transaction(), // Empty placeholder
      direction,
      symbol: this.normalizeSymbol(symbol),
    }
  }

  /**
   * Execute a trade on Pacifica via REST API
   * This is the actual trading method for Pacifica
   */
  async executeTrade(
    params: OpenPositionParams,
    privateKey: Uint8Array
  ): Promise<{ orderId: number; success: boolean }> {
    const normalizedSymbol = this.normalizeSymbol(params.symbol)
    const account = this.walletPubkey.toBase58()

    // First, set leverage for this market
    await this.setLeverage(normalizedSymbol, params.leverage, privateKey)

    // Then, set margin mode to isolated
    await this.setMarginMode(normalizedSymbol, true, privateKey)

    // Calculate position size
    await this.fetchPrices()
    const priceData = this.priceCache.get(normalizedSymbol)
    if (!priceData) {
      throw new Error(`Market ${normalizedSymbol} not found`)
    }

    const markPrice = parseFloat(priceData.mark)
    const notionalUsd = params.marginUsd * params.leverage
    const rawSize = params.sizeAsset ?? notionalUsd / markPrice

    // Round to lot size for this market
    const lotSize = this.getLotSize(params.symbol)
    const sizeAsset = Math.floor(rawSize / lotSize) * lotSize
    const decimals = Math.max(0, -Math.floor(Math.log10(lotSize)))

    // Create market order
    const orderData = {
      symbol: normalizedSymbol,
      amount: sizeAsset.toFixed(decimals),
      side: params.direction === 'long' ? 'bid' : 'ask',
      slippage_percent: '1.0', // 1% slippage
      reduce_only: false,
    }

    const { payload, signature, timestamp } = createSignedPayload(
      'create_market_order',
      orderData,
      privateKey
    )

    const response = await this.fetchWithTimeout(`${PACIFICA_API_BASE}/api/v1/orders/create_market`, 10000, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        account,
        signature,
        timestamp,
        expiry_window: SIGNATURE_EXPIRY_WINDOW_MS,
        ...orderData,
      }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(`Pacifica order failed: ${error.error || response.status}`)
    }

    const result = await response.json()
    return {
      orderId: result.order_id,
      success: true,
    }
  }

  /**
   * Close a position on Pacifica via REST API
   */
  async executeClose(
    symbol: string,
    direction: 'long' | 'short',
    privateKey: Uint8Array
  ): Promise<{ orderId: number; success: boolean }> {
    const normalizedSymbol = this.normalizeSymbol(symbol)
    const account = this.walletPubkey.toBase58()

    // Get current position size
    const positions = await this.getPositions(this.walletPubkey)
    const position = positions.find(
      p => p.symbol === normalizedSymbol && p.direction === direction
    )

    if (!position) {
      throw new Error(`No ${direction} position found for ${normalizedSymbol}`)
    }

    // Round to lot size for this market
    const lotSize = this.getLotSize(symbol)
    const roundedSize = Math.round(position.sizeAsset / lotSize) * lotSize
    const decimals = Math.max(0, -Math.floor(Math.log10(lotSize)))

    // Create reduce-only market order to close
    const orderData = {
      symbol: normalizedSymbol,
      amount: roundedSize.toFixed(decimals),
      side: direction === 'long' ? 'ask' : 'bid', // Opposite side to close
      slippage_percent: '1.0',
      reduce_only: true,
    }

    const { payload, signature, timestamp } = createSignedPayload(
      'create_market_order',
      orderData,
      privateKey
    )

    const response = await this.fetchWithTimeout(`${PACIFICA_API_BASE}/api/v1/orders/create_market`, 10000, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        account,
        signature,
        timestamp,
        expiry_window: SIGNATURE_EXPIRY_WINDOW_MS,
        ...orderData,
      }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(`Pacifica close order failed: ${error.error || response.status}`)
    }

    const result = await response.json()
    return {
      orderId: result.order_id,
      success: true,
    }
  }

  /**
   * Set leverage for a market
   */
  private async setLeverage(
    symbol: string,
    leverage: number,
    privateKey: Uint8Array
  ): Promise<void> {
    const account = this.walletPubkey.toBase58()

    const data = {
      symbol,
      leverage: Math.floor(leverage),
    }

    const { signature, timestamp } = createSignedPayload(
      'update_leverage',
      data,
      privateKey
    )

    const response = await this.fetchWithTimeout(`${PACIFICA_API_BASE}/api/v1/account/leverage`, 10000, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        account,
        signature,
        timestamp,
        expiry_window: SIGNATURE_EXPIRY_WINDOW_MS,
        ...data,
      }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      log.warn(`[pacifica-arb] Failed to set leverage: ${error.error}`)
      // Don't throw - leverage might already be set
    }
  }

  /**
   * Set margin mode (isolated/cross)
   */
  private async setMarginMode(
    symbol: string,
    isIsolated: boolean,
    privateKey: Uint8Array
  ): Promise<void> {
    const account = this.walletPubkey.toBase58()

    const data = {
      symbol,
      is_isolated: isIsolated,
    }

    const { signature, timestamp } = createSignedPayload(
      'update_margin_mode',
      data,
      privateKey
    )

    const response = await this.fetchWithTimeout(`${PACIFICA_API_BASE}/api/v1/account/margin`, 10000, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        account,
        signature,
        timestamp,
        expiry_window: SIGNATURE_EXPIRY_WINDOW_MS,
        ...data,
      }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      log.warn(`[pacifica-arb] Failed to set margin mode: ${error.error}`)
      // Don't throw - margin mode might already be set
    }
  }

  async setStopLoss(
    symbol: string,
    triggerPrice: number,
    signFn: (message: string) => Promise<string>,
  ) {
    return this._setTriggerOrder('sl', symbol, triggerPrice, signFn)
  }

  async setTakeProfit(
    symbol: string,
    triggerPrice: number,
    signFn: (message: string) => Promise<string>,
  ) {
    return this._setTriggerOrder('tp', symbol, triggerPrice, signFn)
  }

  /**
   * Place a TP or SL on an existing position via Pacifica's set_position_tpsl op.
   * Requires an external signing function (e.g., Privy) since the provider
   * doesn't hold private keys in the API context.
   */
  private async _setTriggerOrder(
    type: 'tp' | 'sl',
    symbol: string,
    triggerPrice: number,
    signFn: (message: string) => Promise<string>,
  ): Promise<{ success: boolean; direction: 'long' | 'short' }> {
    const normalizedSymbol = this.normalizeSymbol(symbol)
    const account = this.walletPubkey.toBase58()

    const positions = await this.getPositions(this.walletPubkey)
    const position = positions.find(
      p => p.symbol.toUpperCase() === normalizedSymbol.toUpperCase()
    )
    if (!position) {
      throw new Error(`No position found for ${normalizedSymbol} on Pacifica`)
    }

    // Closing side: ask to close long, bid to close short
    const side = position.direction === 'long' ? 'ask' : 'bid'
    const triggerField = { stop_price: String(triggerPrice) }
    const triggerKey = type === 'tp' ? 'take_profit' : 'stop_loss'

    const { message, timestamp } = createPacificaPayload('set_position_tpsl', {
      symbol: normalizedSymbol,
      side,
      [triggerKey]: triggerField,
    })
    const signature = await signFn(message)

    await executePacificaSetTpsl({
      account,
      symbol,
      side,
      ...(type === 'tp' ? { takeProfit: triggerField } : { stopLoss: triggerField }),
      signature,
      timestamp,
    })

    return { success: true, direction: position.direction as 'long' | 'short' }
  }

  /**
   * Get user's open positions
   */
  async getPositions(wallet: PublicKey, options?: { includeTriggerPrices?: boolean }): Promise<ArbPosition[]> {
    if (!this.isInitialized) {
      return []
    }

    try {
      const account = wallet.toBase58()
      const includeTriggerPrices = options?.includeTriggerPrices !== false
      const positionsPromise = this.fetchWithTimeout(`${PACIFICA_API_BASE}/api/v1/positions?account=${account}`, 10000)
      const ordersPromise = includeTriggerPrices
        ? this.fetchWithTimeout(`${PACIFICA_API_BASE}/api/v1/orders?account=${account}`, 10000).catch(err => {
            log.warn('[pacifica-arb] Failed to fetch orders for TP/SL:', err instanceof Error ? err.message : err)
            return null
          })
        : Promise.resolve(null)
      const [positionsRes, ordersRes] = await Promise.all([
        positionsPromise,
        ordersPromise,
        this.fetchPrices(),
      ])

      if (!positionsRes.ok) {
        return []
      }

      const data = await positionsRes.json()
      if (!data.success || !data.data) {
        return []
      }

      // Pacifica's positions endpoint doesn't surface TP/SL inline; triggers
      // live as separate reduce-only orders on /api/v1/orders.
      const triggerMap = new Map<string, { tp?: number; sl?: number }>()
      if (includeTriggerPrices && ordersRes && ordersRes.ok) {
        try {
          const ordersData = await ordersRes.json()
          const orders: any[] = ordersData?.data ?? []
          for (const order of orders) {
            const orderType = String(order.order_type ?? order.type ?? '').toLowerCase()
            const isTp = orderType.includes('take_profit') || orderType === 'tp' || orderType.includes('takeprofit')
            const isSl = !isTp && (orderType.includes('stop_loss') || orderType === 'sl' || orderType.includes('stoploss') || orderType.includes('stop'))
            if (!isTp && !isSl) continue
            const triggerPriceRaw = order.stop_price ?? order.trigger_price ?? order.stopPrice ?? order.triggerPrice
            const triggerPx = parseFloat(String(triggerPriceRaw ?? ''))
            if (!Number.isFinite(triggerPx) || triggerPx <= 0) continue
            // TP/SL on a long closes via ASK; on a short via BID. Skip orders
            // with an unrecognized side rather than silently defaulting.
            const side = String(order.side ?? '').toLowerCase()
            const direction: 'long' | 'short' | null =
              side === 'ask' ? 'long' : side === 'bid' ? 'short' : null
            if (!direction) continue
            const sym = String(order.symbol ?? '').toUpperCase()
            if (!sym) continue
            const key = `${sym}:${direction}`
            const entry = triggerMap.get(key) || {}
            if (isTp) entry.tp = triggerPx
            else entry.sl = triggerPx
            triggerMap.set(key, entry)
          }
        } catch (err) {
          log.warn('[pacifica-arb] Failed to parse orders response:', err instanceof Error ? err.message : err)
        }
      }

      const positions: ArbPosition[] = []

      for (const pos of data.data as PacificaPosition[]) {
        const symbol = pos.symbol.toUpperCase()
        const direction = pos.side === 'bid' ? 'long' : pos.side === 'ask' ? 'short' : pos.side
        const sizeAsset = parseFloat(pos.amount)
        const entryPrice = parseFloat(pos.entry_price)
        const margin = parseFloat(pos.margin) || 0
        const funding = parseFloat(pos.funding) || 0

        // Get current price for P&L
        const priceData = this.priceCache.get(symbol)
        const currentPrice = priceData
          ? (parseFloat(priceData.oracle) || parseFloat(priceData.mark))
          : entryPrice

        const sizeUsd = sizeAsset * currentPrice
        const leverage = margin > 0 ? sizeUsd / margin : 1

        // Calculate P&L
        const priceChange = currentPrice - entryPrice
        const pnlFromPrice = direction === 'long'
          ? priceChange * sizeAsset
          : -priceChange * sizeAsset
        const pnl = pnlFromPrice - funding // Subtract funding paid

        // Use API liquidation price if available, otherwise compute from Pacifica's formula
        // Docs: liq = (price - side * margin / size) / (1 - side / max_leverage / 2)
        // where side = 1 for long, -1 for short; MMR = 1 / (max_leverage * 2)
        let liquidationPrice: number | undefined
        if (pos.liquidation_price) {
          const parsed = parseFloat(pos.liquidation_price)
          if (parsed > 0) liquidationPrice = parsed
        }
        if (!liquidationPrice && sizeAsset > 0) {
          const marketSpec = this.marketSpecs.get(symbol)
          const maxLeverage = marketSpec?.max_leverage || 50
          const side = direction === 'long' ? 1 : -1
          const computed = (entryPrice - (side * margin) / sizeAsset) / (1 - side / maxLeverage / 2)
          if (computed > 0) liquidationPrice = computed
        }

        const triggerPrices = triggerMap.get(`${symbol}:${direction}`)

        positions.push({
          symbol,
          direction,
          sizeUsd,
          sizeAsset,
          pnl,
          unrealizedPnl: pnlFromPrice,
          fundingIncome: -funding,
          entryPrice,
          leverage,
          margin,
          liquidationPrice,
          triggerPrices,
        })
      }

      return positions
    } catch (error) {
      log.error('[pacifica-arb] Error fetching positions:', error)
      return []
    }
  }

  /**
   * Get account info
   */
  async getAccountInfo(wallet: PublicKey): Promise<PacificaAccountInfo | null> {
    try {
      const account = wallet.toBase58()
      const response = await this.fetchWithTimeout(
        `${PACIFICA_API_BASE}/api/v1/account?account=${account}`,
        10000
      )

      if (!response.ok) {
        return null
      }

      const data = await response.json()
      return data.success ? data.data : null
    } catch (error) {
      log.error('[pacifica-arb] Error fetching account info:', error)
      return null
    }
  }

  /**
   * Normalize symbol to Pacifica format
   * Pacifica uses: BTC, ETH, SOL, kBONK, kPEPE, etc.
   */
  private normalizeSymbol(symbol: string): string {
    const upper = symbol.toUpperCase()

    // Handle k-prefixed symbols (kBONK, kPEPE)
    if (upper.startsWith('K') && upper.length > 1) {
      return 'k' + upper.slice(1)
    }

    return upper
  }

  /**
   * Get the max leverage for a specific market (used for MMR calculation).
   * Pacifica MMR = 1 / (max_leverage * 2)
   */
  getMaxLeverage(symbol: string): number {
    const normalizedSymbol = this.normalizeSymbol(symbol)
    const spec = this.marketSpecs.get(normalizedSymbol)
    return spec?.max_leverage || 50
  }

  /**
   * Get the lot size (tick_size) for a specific market.
   * Returns the minimum size increment — orders must be a multiple of this.
   */
  getLotSize(symbol: string): number {
    const normalizedSymbol = this.normalizeSymbol(symbol)
    const spec = this.marketSpecs.get(normalizedSymbol)
    if (spec?.lot_size) {
      return parseFloat(spec.lot_size)
    }
    return 0.01 // fallback
  }

  /**
   * Get historical funding payments for this user.
   * Exhausts cursor-based pagination to return complete history.
   */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPaymentsResult> {
    if (!this.isInitialized) return { payments: [], truncated: false }

    try {
      const account = this.walletPubkey.toBase58()
      const payments: FundingPayment[] = []
      let cursor: string | undefined
      let hasMore = true
      let pages = 0
      const MAX_PAGES = 50

      while (hasMore && pages < MAX_PAGES) {
        pages++
        const url = new URL(`${PACIFICA_API_BASE}/api/v1/funding/history`)
        url.searchParams.set('account', account)
        url.searchParams.set('limit', '100')
        if (cursor) url.searchParams.set('cursor', cursor)

        const response = await this.fetchWithTimeout(url.toString(), 15000)
        if (!response.ok) {
          throw new Error(`Pacifica funding history failed: ${response.status}`)
        }

        const data = await response.json() as {
          success: boolean
          data: Array<{
            symbol: string
            side: string
            amount: string
            payout: string
            rate: string
            created_at: number
          }>
          next_cursor?: string
          has_more?: boolean
        }

        if (!data.success || !data.data) break

        for (const entry of data.data) {
          const ts = entry.created_at
          if (startTime && ts < startTime) { hasMore = false; break }
          if (endTime && ts > endTime) continue

          payments.push({
            symbol: entry.symbol.toUpperCase(),
            amount: -parseFloat(entry.payout),
            rate: parseFloat(entry.rate),
            timestamp: ts,
            direction: entry.side === 'bid' ? 'long' : 'short',
          })
        }

        cursor = data.next_cursor
        hasMore = hasMore && (data.has_more === true) && !!cursor
      }

      const truncated = pages >= MAX_PAGES && hasMore
      return { payments, truncated }
    } catch (error) {
      log.error('[pacifica-arb] Error fetching funding payments:', error)
      throw error
    }
  }

  async cleanup(): Promise<void> {
    this.marketSpecs.clear()
    this.priceCache.clear()
    this.priceCacheTimestamp = 0
    this.privateKey = null
    this.isInitialized = false
  }
}

export function createPacificaArbProvider(walletPubkey: PublicKey): PacificaArbProvider {
  return new PacificaArbProvider(walletPubkey)
}

/**
 * Normalize symbol to Pacifica format (exported for use in trade handlers)
 */
export function normalizePacificaSymbol(symbol: string): string {
  const upper = symbol.toUpperCase()

  // Handle k-prefixed symbols (kBONK, kPEPE)
  if (upper.startsWith('K') && upper.length > 1) {
    return 'k' + upper.slice(1)
  }

  return upper
}

/**
 * Set leverage for a market via REST API with external signature
 * Must be called before placing orders to ensure correct leverage
 */
export async function setPacificaLeverage(params: {
  account: string
  symbol: string
  leverage: number
  signature: string
  timestamp: number
}): Promise<void> {
  const { account, symbol, leverage, signature, timestamp } = params

  let apiUrl = `${PACIFICA_API_BASE}/api/v1/account/leverage`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (PACIFICA_IPV4) {
    apiUrl = apiUrl.replace(PACIFICA_HOST, PACIFICA_IPV4)
    headers['Host'] = PACIFICA_HOST
  }

  const body = {
    account,
    signature,
    timestamp,
    expiry_window: SIGNATURE_EXPIRY_WINDOW_MS,
    symbol: normalizePacificaSymbol(symbol),
    leverage: Math.floor(leverage),
  }

  log.info(`[pacifica-arb] Setting leverage: ${leverage}x for ${symbol}`)

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const responseText = await response.text()
  log.info(`[pacifica-arb] Leverage response status: ${response.status}`)
  log.info(`[pacifica-arb] Leverage response body: ${responseText}`)

  if (!response.ok) {
    // Don't throw - leverage might already be set or there's a minor issue
    log.warn(`[pacifica-arb] Failed to set leverage (continuing anyway): ${responseText}`)
  }
}

/**
 * Set margin mode (isolated/cross) via REST API with external signature
 * Must be called before placing orders to ensure isolated margin
 */
export async function setPacificaMarginMode(params: {
  account: string
  symbol: string
  isIsolated: boolean
  signature: string
  timestamp: number
}): Promise<void> {
  const { account, symbol, isIsolated, signature, timestamp } = params

  let apiUrl = `${PACIFICA_API_BASE}/api/v1/account/margin`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (PACIFICA_IPV4) {
    apiUrl = apiUrl.replace(PACIFICA_HOST, PACIFICA_IPV4)
    headers['Host'] = PACIFICA_HOST
  }

  const body = {
    account,
    signature,
    timestamp,
    expiry_window: SIGNATURE_EXPIRY_WINDOW_MS,
    symbol: normalizePacificaSymbol(symbol),
    is_isolated: isIsolated,
  }

  log.info(`[pacifica-arb] Setting margin mode: ${isIsolated ? 'isolated' : 'cross'} for ${symbol}`)

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const responseText = await response.text()
  log.info(`[pacifica-arb] Margin mode response status: ${response.status}`)

  if (!response.ok) {
    // Don't throw - margin mode might already be set
    log.warn(`[pacifica-arb] Failed to set margin mode (continuing anyway): ${responseText}`)
  }
}

/**
 * Execute a Pacifica market order with external signature (e.g., from Privy)
 * This is used when the private key is not directly available
 */
export async function executePacificaMarketOrder(params: {
  account: string
  symbol: string
  amount: string
  side: 'bid' | 'ask'
  reduceOnly: boolean
  signature: string  // Base58 encoded signature from Privy
  timestamp: number
  slippagePercent?: string
}): Promise<{ orderId: number; success: boolean }> {
  const {
    account,
    symbol,
    amount,
    side,
    reduceOnly,
    signature,
    timestamp,
    slippagePercent = '1.0',
  } = params

  // Build the request URL with IPv4 if available
  let apiUrl = `${PACIFICA_API_BASE}/api/v1/orders/create_market`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (PACIFICA_IPV4) {
    apiUrl = apiUrl.replace(PACIFICA_HOST, PACIFICA_IPV4)
    headers['Host'] = PACIFICA_HOST
  }

  // Request body: flattened data + auth fields (no 'type' - that's only in signed message)
  const body = {
    account,
    signature,
    timestamp,
    expiry_window: SIGNATURE_EXPIRY_WINDOW_MS,
    // Order data (flattened)
    symbol: normalizePacificaSymbol(symbol),
    amount,
    side,
    slippage_percent: slippagePercent,
    reduce_only: reduceOnly,
  }

  log.info(`[pacifica-arb] Executing market order: ${side} ${amount} ${symbol}`)
  log.info(`[pacifica-arb] Request body:`, JSON.stringify(body, null, 2))

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const responseText = await response.text()
  log.info(`[pacifica-arb] Response status: ${response.status}`)
  log.info(`[pacifica-arb] Response body: ${responseText}`)

  if (!response.ok) {
    let errorData: any = { error: 'Unknown error' }
    try {
      errorData = JSON.parse(responseText)
    } catch {
      errorData = { error: responseText || `HTTP ${response.status}` }
    }
    log.error(`[pacifica-arb] Order failed:`, errorData)
    throw new Error(`Pacifica order failed: ${errorData.error || errorData.message || response.status}`)
  }

  const result = JSON.parse(responseText)
  // Response format: { success: true, data: { order_id: 123 }, error: null }
  const orderId = result.data?.order_id || result.order_id
  log.info(`[pacifica-arb] Order successful: orderId=${orderId}`)

  return {
    orderId,
    success: true,
  }
}

/** Pacifica referral code for PayStream */
const PACIFICA_REFERRAL_CODE = 'Paystream'

/** Referral claim uses a shorter expiry window (5 seconds) per Pacifica docs */
const REFERRAL_EXPIRY_WINDOW_MS = 5_000

/**
 * Create the message to sign for claiming a referral code.
 * Returns the message string and timestamp (to be signed externally via Privy).
 */
export function createReferralClaimPayload(): { message: string; timestamp: number } {
  const timestamp = Date.now()
  const messagePayload = {
    type: 'claim_referral_code',
    timestamp,
    expiry_window: REFERRAL_EXPIRY_WINDOW_MS,
    data: { code: PACIFICA_REFERRAL_CODE },
  }
  const sorted = sortObjectKeys(messagePayload)
  return { message: JSON.stringify(sorted), timestamp }
}

/**
 * Claim Pacifica referral code for a user.
 * Uses external signature (e.g., from Privy).
 * Silently ignores errors (code may already be claimed).
 */
export async function claimPacificaReferralCode(params: {
  account: string
  signature: string
  timestamp: number
}): Promise<void> {
  const { account, signature, timestamp } = params

  let apiUrl = `${PACIFICA_API_BASE}/api/v1/referral/user/code/claim`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (PACIFICA_IPV4) {
    apiUrl = apiUrl.replace(PACIFICA_HOST, PACIFICA_IPV4)
    headers['Host'] = PACIFICA_HOST
  }

  const body = {
    account,
    agent_wallet: null,
    signature,
    timestamp,
    expiry_window: REFERRAL_EXPIRY_WINDOW_MS,
    code: PACIFICA_REFERRAL_CODE,
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    const responseText = await response.text()

    if (response.ok) {
      log.info(`[pacifica-arb] Referral code '${PACIFICA_REFERRAL_CODE}' claimed for ${account}`)
    } else {
      // Silently ignore — user likely already claimed the code
      log.info(`[pacifica-arb] Referral code claim skipped (${response.status}): ${responseText}`)
    }
  } catch (error) {
    // Don't throw — referral claim is best-effort
    log.warn(`[pacifica-arb] Referral code claim failed:`, error)
  }
}

/**
 * Set TP/SL on an existing Pacifica position.
 * Uses external signature (e.g., from Privy).
 * Calls POST /api/v1/positions/tpsl
 */
export async function executePacificaSetTpsl(params: {
  account: string
  symbol: string
  side: 'bid' | 'ask'
  stopLoss?: { stop_price: string; limit_price?: string }
  takeProfit?: { stop_price: string; limit_price?: string }
  signature: string
  timestamp: number
}): Promise<{ success: boolean }> {
  const { account, symbol, side, stopLoss, takeProfit, signature, timestamp } = params

  let apiUrl = `${PACIFICA_API_BASE}/api/v1/positions/tpsl`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (PACIFICA_IPV4) {
    apiUrl = apiUrl.replace(PACIFICA_HOST, PACIFICA_IPV4)
    headers['Host'] = PACIFICA_HOST
  }

  const body: Record<string, any> = {
    account,
    signature,
    timestamp,
    expiry_window: SIGNATURE_EXPIRY_WINDOW_MS,
    symbol: normalizePacificaSymbol(symbol),
    side,
  }
  if (stopLoss) body.stop_loss = stopLoss
  if (takeProfit) body.take_profit = takeProfit

  log.info(`[pacifica-arb] Setting TP/SL: ${symbol} ${side}`, JSON.stringify(body))

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const responseText = await response.text()
  log.info(`[pacifica-arb] TP/SL response: ${response.status} ${responseText}`)

  if (!response.ok) {
    let errorData: any
    try {
      errorData = JSON.parse(responseText)
    } catch {
      errorData = { error: responseText || `HTTP ${response.status}` }
    }
    throw new Error(`Pacifica set TP/SL failed: ${errorData.error || errorData.message || response.status}`)
  }

  return { success: true }
}
