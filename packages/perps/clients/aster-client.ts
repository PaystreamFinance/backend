import { createHmac } from 'crypto'
import { log } from '../logger'

const ASTER_BASE_URL = 'https://fapi.asterdex.com'
const FETCH_TIMEOUT_MS = 15_000

/**
 * Exchange info for a single symbol
 */
export interface AsterLeverageBracket {
  bracket: number
  initialLeverage: number
  notionalCap: number
  notionalFloor: number
  maintMarginRatio: number
  cum: number
}

export interface AsterSymbolInfo {
  symbol: string
  pricePrecision: number
  quantityPrecision: number
  tickSize: string
  stepSize: string
  contractType: string
  baseAsset: string
  quoteAsset: string
  maxLeverage?: number
  brackets?: AsterLeverageBracket[]
}

/**
 * Premium index response (mark price + funding)
 */
export interface AsterPremiumIndex {
  symbol: string
  markPrice: string
  lastFundingRate: string
  nextFundingTime: number
  indexPrice: string
}

/**
 * Funding info response from /fapi/v3/fundingInfo
 */
export interface AsterFundingInfo {
  symbol: string
  fundingIntervalHours: number
  fundingFeeCap: number
  fundingFeeFloor: number
}

/**
 * Account info response
 */
export interface AsterAccountInfo {
  totalWalletBalance: string
  availableBalance: string
  positions: AsterPositionRisk[]
}

/**
 * Position risk response
 */
export interface AsterPositionRisk {
  symbol: string
  positionAmt: string
  entryPrice: string
  markPrice: string
  unRealizedProfit: string
  liquidationPrice: string
  leverage: string
  marginType: string
  isolatedMargin: string
  notional: string
  positionSide: string
  maxNotionalValue?: string
}

/**
 * Order response
 */
export interface AsterOrderResponse {
  orderId: number
  symbol: string
  status: string
  price: string
  avgPrice: string
  origQty: string
  executedQty: string
  type: string
  side: string
  timeInForce: string
}

/**
 * Open order from GET /fapi/v1/openOrders.
 * `type` STOP_MARKET / TAKE_PROFIT_MARKET (or _LIMIT) carries TP/SL triggers
 * with `stopPrice` as the trigger price.
 */
export interface AsterOpenOrder {
  orderId: number
  symbol: string
  status: string
  price: string
  avgPrice: string
  origQty: string
  executedQty: string
  type: string
  side: 'BUY' | 'SELL'
  positionSide?: string
  stopPrice: string
  closePosition: boolean
  reduceOnly: boolean
  timeInForce: string
  workingType: string
}

/**
 * Response from POST /fapi/v1/leverage
 */
export interface AsterLeverageResponse {
  leverage: number
  maxNotionalValue: string
  symbol: string
}

/**
 * Withdraw fee estimation response
 */
export interface AsterWithdrawFeeEstimate {
  gasPrice: string | null
  gasLimit: string
  tokenPrice: string
  gasCost: string
  gasUsdValue: string
}

/**
 * Withdraw response
 */
export interface AsterWithdrawResponse {
  withdrawId: string
  hash: string
}

/**
 * Balance entry from /fapi/v2/balance
 */
export interface AsterBalanceEntry {
  accountAlias: string
  asset: string
  balance: string
  crossWalletBalance: string
  crossUnPnl: string
  availableBalance: string
  maxWithdrawAmount: string
  marginAvailable: boolean
  updateTime: number
}

/**
 * Income entry from /fapi/v1/income
 */
export interface AsterIncomeEntry {
  symbol: string
  incomeType: string
  income: string
  asset: string
  time: number
  tranId: number
  info: string
}

/**
 * Funding rate entry
 */
export interface AsterFundingRate {
  symbol: string
  fundingRate: string
  fundingTime: number
}

/**
 * Low-level REST client for Aster DEX (Binance-compatible API)
 * Signed endpoints use HMAC-SHA256 (v1/v2/v4). Public endpoints use v3.
 */
export class AsterClient {
  private apiKey: string | null = null
  private apiSecret: string | null = null
  private precisionCache: Map<string, AsterSymbolInfo> = new Map()

  setApiCredentials(apiKey: string, apiSecret: string): void {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
  }

  hasCredentials(): boolean {
    return this.apiKey !== null && this.apiSecret !== null
  }

  /**
   * Sign request params using HMAC-SHA256:
   * 1. Add recvWindow + timestamp to params
   * 2. Build query string key=value&key=value (insertion order, must match URL)
   * 3. HMAC-SHA256 sign with apiSecret
   * 4. Return params with signature appended
   */
  private signParams(params: Record<string, any>): Record<string, any> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API credentials not set. Call setApiCredentials() first.')
    }

    const timestamp = Date.now()
    const allParams: Record<string, string> = {}

    for (const [key, value] of Object.entries(params)) {
      allParams[key] = String(value)
    }
    allParams['recvWindow'] = '50000'
    allParams['timestamp'] = String(timestamp)

    // Build query string in insertion order (must match URL param order for HMAC)
    const queryString = Object.entries(allParams).map(([k, v]) => `${k}=${v}`).join('&')

    // HMAC-SHA256
    const signature = createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex')

    return {
      ...allParams,
      signature,
    }
  }

  /**
   * Make a public GET request (no signing)
   */
  private async publicGet<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${ASTER_BASE_URL}${path}`)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
      }
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    const text = await response.text()

    if (!response.ok) {
      throw new Error(`Aster API error ${response.status}: ${text}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Aster API returned invalid JSON from ${path}: ${text.slice(0, 200)}`)
    }
  }

  /**
   * Make a signed GET request
   */
  private async signedGet<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const signedParams = this.signParams(params)
    const url = new URL(`${ASTER_BASE_URL}${path}`)
    for (const [key, value] of Object.entries(signedParams)) {
      url.searchParams.set(key, value)
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': this.apiKey!,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    const text = await response.text()

    if (!response.ok) {
      log.error(`[aster-client] signed GET ${path} failed ${response.status}: ${text.slice(0, 300)}`)
      throw new Error(`Aster signed GET error ${response.status}: ${text}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      log.error(`[aster-client] signed GET ${path} invalid JSON: ${text.slice(0, 300)}`)
      throw new Error(`Aster API returned invalid JSON from ${path}: ${text.slice(0, 200)}`)
    }
  }

  /**
   * Make a signed POST request
   * Binance-compatible APIs expect query string params, not JSON body
   */
  private async signedPost<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const signedParams = this.signParams(params)
    const url = new URL(`${ASTER_BASE_URL}${path}`)
    for (const [key, value] of Object.entries(signedParams)) {
      url.searchParams.set(key, value)
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey!,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    const text = await response.text()

    if (!response.ok) {
      log.error(`[aster-client] signed POST ${path} failed ${response.status}: ${text.slice(0, 300)}`)
      throw new Error(`Aster signed POST error ${response.status}: ${text}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      log.error(`[aster-client] signed POST ${path} invalid JSON: ${text.slice(0, 300)}`)
      throw new Error(`Aster API returned invalid JSON from ${path}: ${text.slice(0, 200)}`)
    }
  }

  /**
   * Make a signed DELETE request
   */
  private async signedDelete<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const signedParams = this.signParams(params)
    const url = new URL(`${ASTER_BASE_URL}${path}`)
    for (const [key, value] of Object.entries(signedParams)) {
      url.searchParams.set(key, value)
    }

    const response = await fetch(url.toString(), {
      method: 'DELETE',
      headers: {
        'X-MBX-APIKEY': this.apiKey!,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    const text = await response.text()

    if (!response.ok) {
      log.error(`[aster-client] signed DELETE ${path} failed ${response.status}: ${text.slice(0, 300)}`)
      throw new Error(`Aster signed DELETE error ${response.status}: ${text}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      log.error(`[aster-client] signed DELETE ${path} invalid JSON: ${text.slice(0, 300)}`)
      throw new Error(`Aster API returned invalid JSON from ${path}: ${text.slice(0, 200)}`)
    }
  }

  // ==================== Public Endpoints ====================

  /**
   * GET /fapi/v3/exchangeInfo
   * Fetch exchange info including all symbol precisions
   */
  async getExchangeInfo(): Promise<{ symbols: AsterSymbolInfo[] }> {
    const data = await this.publicGet<any>('/fapi/v3/exchangeInfo')

    // Cache precision info
    if (data.symbols) {
      for (const sym of data.symbols) {
        // Extract tick/step size from filters
        let tickSize = '0.01'
        let stepSize = '0.01'
        if (sym.filters) {
          for (const filter of sym.filters) {
            if (filter.filterType === 'PRICE_FILTER') tickSize = filter.tickSize
            if (filter.filterType === 'LOT_SIZE') stepSize = filter.stepSize
          }
        }

        this.precisionCache.set(sym.symbol, {
          symbol: sym.symbol,
          pricePrecision: sym.pricePrecision || 2,
          quantityPrecision: sym.quantityPrecision || 3,
          tickSize,
          stepSize,
          contractType: sym.contractType || 'PERPETUAL',
          baseAsset: sym.baseAsset || '',
          quoteAsset: sym.quoteAsset || 'USDC',
        })
      }
    }

    return data
  }

  /**
   * GET /fapi/v3/premiumIndex
   * Get mark price and funding rate for a symbol (or all symbols)
   */
  async getPremiumIndex(symbol?: string): Promise<AsterPremiumIndex | AsterPremiumIndex[]> {
    const params: Record<string, string> = {}
    if (symbol) params.symbol = symbol
    return this.publicGet(symbol ? '/fapi/v3/premiumIndex' : '/fapi/v3/premiumIndex', params)
  }

  /**
   * GET /fapi/v3/fundingInfo
   * Get funding interval and caps per symbol (public, no auth)
   */
  async getFundingInfo(symbol?: string): Promise<AsterFundingInfo[]> {
    const params: Record<string, string> = {}
    if (symbol) params.symbol = symbol
    return this.publicGet('/fapi/v3/fundingInfo', params)
  }

  /**
   * GET /fapi/v3/fundingRate
   * Get historical funding rates
   */
  async getFundingRates(symbol?: string, limit?: number): Promise<AsterFundingRate[]> {
    const params: Record<string, string> = {}
    if (symbol) params.symbol = symbol
    if (limit) params.limit = String(limit)
    return this.publicGet('/fapi/v3/fundingRate', params)
  }

  /**
   * GET /fapi/v3/openInterest
   * Get open interest for a symbol (base asset units)
   */
  async getOpenInterest(symbol: string): Promise<{ symbol: string; openInterest: string; time: number }> {
    return this.publicGet('/fapi/v3/openInterest', { symbol })
  }

  /**
   * GET /fapi/v3/ticker/price
   * Get current price for a symbol
   */
  async getTickerPrice(symbol?: string): Promise<{ symbol: string; price: string } | Array<{ symbol: string; price: string }>> {
    const params: Record<string, string> = {}
    if (symbol) params.symbol = symbol
    return this.publicGet('/fapi/v3/ticker/price', params)
  }

  // ==================== Signed Endpoints ====================

  /**
   * GET /fapi/v4/account (signed, HMAC)
   * Get account info including balances and positions
   */
  async getAccount(): Promise<AsterAccountInfo> {
    return this.signedGet('/fapi/v4/account')
  }

  /**
   * GET /fapi/v2/balance (signed, HMAC)
   * Get futures account balance per asset
   */
  async getBalance(): Promise<AsterBalanceEntry[]> {
    return this.signedGet('/fapi/v2/balance')
  }

  /**
   * GET /fapi/v1/income (signed, HMAC)
   * Get income history (funding fees, commissions, etc.)
   */
  async getIncome(params: { symbol?: string; incomeType?: string; startTime?: number; limit?: number } = {}): Promise<AsterIncomeEntry[]> {
    return this.signedGet('/fapi/v1/income', params)
  }

  /**
   * GET /fapi/v2/positionRisk (signed, HMAC)
   * Get position risk info
   */
  async getPositionRisk(symbol?: string): Promise<AsterPositionRisk[]> {
    const params: Record<string, any> = {}
    if (symbol) params.symbol = symbol
    return this.signedGet('/fapi/v2/positionRisk', params)
  }

  /**
   * POST /fapi/v1/leverage (signed, HMAC)
   * Set leverage for a symbol. Response includes `maxNotionalValue` — the max
   * total position notional allowed at that leverage (applies to existing + new).
   */
  async setLeverage(symbol: string, leverage: number): Promise<AsterLeverageResponse> {
    return this.signedPost('/fapi/v1/leverage', {
      symbol,
      leverage: Math.floor(leverage),
    })
  }

  /**
   * POST /fapi/v1/marginType (signed, HMAC)
   * Set margin type (CROSSED or ISOLATED)
   */
  async setMarginType(symbol: string, marginType: 'CROSSED' | 'ISOLATED'): Promise<any> {
    return this.signedPost('/fapi/v1/marginType', {
      symbol,
      marginType,
    })
  }

  /**
   * GET /fapi/v1/multiAssetsMargin (signed, HMAC)
   * Get current multi-assets mode
   */
  async getMultiAssetsMode(): Promise<{ multiAssetsMargin: boolean }> {
    return this.signedGet('/fapi/v1/multiAssetsMargin')
  }

  /**
   * POST /fapi/v1/multiAssetsMargin (signed, HMAC)
   * Set single-asset (false) or multi-asset (true) mode
   */
  async setMultiAssetsMode(enabled: boolean): Promise<any> {
    return this.signedPost('/fapi/v1/multiAssetsMargin', {
      multiAssetsMargin: String(enabled),
    })
  }

  /**
   * POST /fapi/v1/order (signed, HMAC)
   * Place an order
   */
  async placeOrder(params: {
    symbol: string
    side: 'BUY' | 'SELL'
    type: 'LIMIT' | 'MARKET' | 'STOP' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'TAKE_PROFIT_MARKET'
    quantity?: string
    price?: string
    stopPrice?: string
    timeInForce?: 'GTC' | 'IOC' | 'FOK'
    reduceOnly?: boolean
    closePosition?: boolean
    workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
    priceProtect?: boolean
  }): Promise<AsterOrderResponse> {
    const orderParams: Record<string, any> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
    }
    if (params.quantity) orderParams.quantity = params.quantity
    if (params.price) orderParams.price = params.price
    if (params.stopPrice) orderParams.stopPrice = params.stopPrice
    if (params.timeInForce) orderParams.timeInForce = params.timeInForce
    if (params.reduceOnly !== undefined) orderParams.reduceOnly = String(params.reduceOnly)
    if (params.closePosition !== undefined) orderParams.closePosition = String(params.closePosition)
    if (params.workingType) orderParams.workingType = params.workingType
    if (params.priceProtect !== undefined) orderParams.priceProtect = String(params.priceProtect)

    return this.signedPost('/fapi/v1/order', orderParams)
  }

  /**
   * DELETE /fapi/v1/allOpenOrders (signed, HMAC)
   * Cancel all open orders for a symbol
   */
  async cancelAllOrders(symbol: string): Promise<any> {
    return this.signedDelete('/fapi/v1/allOpenOrders', { symbol })
  }

  /**
   * GET /fapi/v1/openOrders (signed, HMAC)
   * List open orders. Pass `symbol` to scope to one market, omit for all.
   * Used to read currently-set TP/SL trigger orders.
   */
  async getOpenOrders(symbol?: string): Promise<AsterOpenOrder[]> {
    const params: Record<string, string | number | boolean> = {}
    if (symbol) params.symbol = symbol
    return this.signedGet<AsterOpenOrder[]>('/fapi/v1/openOrders', params)
  }

  // ==================== Withdraw Endpoints ====================

  /**
   * GET estimate-withdraw-fee (public, on www.asterdex.com)
   * Estimate the gas fee for a Solana withdrawal
   */
  async estimateWithdrawFee(currency: string): Promise<AsterWithdrawFeeEstimate> {
    const url = `https://www.asterdex.com/bapi/futures/v1/public/future/aster/estimate-withdraw-fee?chainId=101&network=SOL&currency=${currency}&accountType=perp`
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Aster estimate-withdraw-fee error ${response.status}: ${text}`)
    }

    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`Aster estimate-withdraw-fee: invalid JSON: ${text.slice(0, 200)}`)
    }

    if (!data.data) {
      throw new Error(`Aster estimate-withdraw-fee: no data: ${text.slice(0, 200)}`)
    }

    return data.data as AsterWithdrawFeeEstimate
  }

  /**
   * POST /fapi/aster/user-solana-withdraw (signed, HMAC)
   * Withdraw USDT from perp account to a Solana wallet address
   */
  async withdraw(amount: string, fee: string, receiver: string): Promise<AsterWithdrawResponse> {
    return this.signedPost('/fapi/aster/user-solana-withdraw', {
      chainId: 101,
      asset: 'USDT',
      amount,
      fee,
      receiver,
    })
  }

  /**
   * GET /fapi/v1/leverageBracket (signed with read-only service credentials)
   * Fetch leverage brackets for all symbols (max leverage per position tier)
   * Updates maxLeverage in precisionCache using the first bracket's initialLeverage
   */
  async fetchAndCacheLeverageBrackets(): Promise<void> {
    // Read-only service API key for fetching market metadata
    const SERVICE_API_KEY = '7a5d70b9dd1f9fdd637cc00bd7cfd78bedbfc4e123f2c97d8f5c01e11d8db2c5'
    const SERVICE_API_SECRET = '71ef747565edaf292acca40cccd87ce3c757a2e5c4d73696966063e88d19f355'

    const savedKey = this.apiKey
    const savedSecret = this.apiSecret
    try {
      this.setApiCredentials(SERVICE_API_KEY, SERVICE_API_SECRET)
      const data = await this.signedGet<any[]>('/fapi/v1/leverageBracket', {})
      if (!Array.isArray(data)) return

      for (const entry of data) {
        const symbol = entry.symbol
        const brackets = entry.brackets
        if (!symbol || !Array.isArray(brackets) || brackets.length === 0) continue

        // First bracket = smallest position size = max leverage
        const maxLeverage = brackets[0].initialLeverage
        if (typeof maxLeverage !== 'number' || maxLeverage <= 0) continue

        const normalized: AsterLeverageBracket[] = brackets.map((b: any) => ({
          bracket: Number(b.bracket),
          initialLeverage: Number(b.initialLeverage),
          notionalCap: Number(b.notionalCap),
          notionalFloor: Number(b.notionalFloor),
          maintMarginRatio: Number(b.maintMarginRatio),
          cum: Number(b.cum ?? 0),
        }))

        const cached = this.precisionCache.get(symbol)
        if (cached) {
          cached.maxLeverage = maxLeverage
          cached.brackets = normalized
        }
      }
    } catch (error) {
      log.warn('[aster-client] Could not fetch leverage brackets:', error instanceof Error ? error.message : error)
    } finally {
      // Restore original credentials (null for market-data-only clients)
      this.apiKey = savedKey
      this.apiSecret = savedSecret
    }
  }

  // ==================== Helpers ====================

  /**
   * Get cached precision info for a symbol
   */
  getSymbolInfo(symbol: string): AsterSymbolInfo | undefined {
    return this.precisionCache.get(symbol)
  }

  /**
   * Get all cached symbol infos
   */
  getAllSymbolInfos(): Map<string, AsterSymbolInfo> {
    return this.precisionCache
  }
}

export function createAsterClient(): AsterClient {
  return new AsterClient()
}
