import { getAddress } from 'viem'
import { log } from '../logger'

const LIGHTER_BASE_URL = 'https://mainnet.zklighter.elliot.ai'

/**
 * Order book detail from Lighter API (/api/v1/orderBookDetails)
 */
export interface LighterOrderBookDetail {
  symbol: string
  market_id: number
  market_type: string
  base_asset_id: number
  quote_asset_id: number
  status: string
  taker_fee: string
  maker_fee: string
  liquidation_fee: string
  min_base_amount: string
  min_quote_amount: string
  order_quote_limit: string
  supported_size_decimals: number
  supported_price_decimals: number
  supported_quote_decimals: number
  size_decimals: number
  price_decimals: number
  last_trade_price: number
  daily_trades_count: number
  daily_base_token_volume: number
  daily_quote_token_volume: number
  open_interest: number
  default_initial_margin_fraction: number
  min_initial_margin_fraction: number
  maintenance_margin_fraction: number
}

/**
 * Account info from Lighter API
 */
export interface LighterAccountInfo {
  account_index: number
  l1_address: string
  balance: string
  available_balance: string
  positions: LighterPosition[]
}

/**
 * Position from Lighter API (/api/v1/account)
 * Actual field names from the API — NOT the old guessed names.
 */
export interface LighterPosition {
  market_id: number
  symbol: string
  initial_margin_fraction: string
  sign: number // 1 = long, -1 = short
  position: string // absolute size
  avg_entry_price: string
  position_value: string
  unrealized_pnl: string
  realized_pnl: string
  liquidation_price: string
  margin_mode: number // 0 = isolated, 1 = cross
  allocated_margin: string
  total_funding_paid_out?: string
}

/**
 * Funding rate entry from /api/v1/funding-rates
 */
export interface LighterFundingRate {
  market_id: number
  exchange: string
  symbol: string
  rate: number
}

/**
 * Order response from Lighter API
 */
export interface LighterOrderResponse {
  tx_hash: string
  order_index: number
  status: string
}

/**
 * Active order from /api/v1/accountActiveOrders.
 * `type` is either a numeric code (2/3 = stop-loss, 4/5 = take-profit) or a
 * string ("stop-loss" / "take-profit", optionally with "-limit" suffix).
 */
export interface LighterActiveOrder {
  market_index: number
  order_index: number
  client_order_index?: number
  is_ask: boolean | number
  price: string
  trigger_price?: string
  remaining_base_amount?: string
  initial_base_amount?: string
  type: number | string
  time_in_force?: number | string
  reduce_only?: boolean | number
  status?: string | number
  timestamp?: number
}

/**
 * A single position funding payment entry from /api/v1/positionFunding
 */
export interface LighterPositionFundingEntry {
  market_id: number
  funding_id: number
  timestamp: number
  change: string
  rate: string
  position_size: string
  position_side: 'long' | 'short'
  discount: string
}

/**
 * Response from /api/v1/positionFunding
 */
export interface LighterPositionFundingResponse {
  position_fundings?: LighterPositionFundingEntry[]
  next_cursor?: string
}

/**
 * Market data derived from orderBookDetails
 * (marketData endpoint is not available)
 */
export interface LighterMarketData {
  market_id: number
  symbol: string
  mark_price: string
  index_price: string
  funding_rate: string
  open_interest: string
}

/**
 * Low-level REST client for Lighter DEX
 * Uses the zklighter-sdk for signing when available,
 * falls back to raw REST for public endpoints.
 */
export class LighterClient {
  private marketCache: Map<number, LighterOrderBookDetail> = new Map()
  private symbolToMarketIndex: Map<string, number> = new Map()

  /**
   * Make a GET request to Lighter API
   */
  private async get<T>(path: string, params?: Record<string, string>, authToken?: string): Promise<T> {
    const url = new URL(`${LIGHTER_BASE_URL}${path}`)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authToken) headers['Authorization'] = authToken

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers,
      cache: 'no-store',
    })

    const text = await response.text()

    if (!response.ok) {
      throw new Error(`Lighter API error ${response.status}: ${text}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Lighter API returned invalid JSON from ${path}: ${text.slice(0, 200)}`)
    }
  }

  /**
   * Make a POST request to Lighter API
   */
  private async post<T>(path: string, body: any): Promise<T> {
    const response = await fetch(`${LIGHTER_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const text = await response.text()

    if (!response.ok) {
      throw new Error(`Lighter API error ${response.status}: ${text}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Lighter API returned invalid JSON from ${path}: ${text.slice(0, 200)}`)
    }
  }

  // ==================== Public Endpoints ====================

  /**
   * GET /api/v1/orderBookDetails
   * Fetch all order book details (market metadata including prices)
   */
  async getOrderBookMetas(): Promise<LighterOrderBookDetail[]> {
    const data = await this.get<any>('/api/v1/orderBookDetails')
    const details: LighterOrderBookDetail[] = data.order_book_details || []

    // Cache market info — only perp markets
    for (const detail of details) {
      if (detail.market_type !== 'perp') continue
      this.marketCache.set(detail.market_id, detail)
      this.symbolToMarketIndex.set(detail.symbol.toUpperCase(), detail.market_id)
    }

    return details.filter(d => d.market_type === 'perp')
  }

  /**
   * GET /api/v1/funding-rates
   * Fetch current funding rates for all markets across exchanges.
   * Filter by exchange === 'lighter' to get Lighter's own rates.
   */
  async getFundingRates(): Promise<LighterFundingRate[]> {
    const data = await this.get<any>('/api/v1/funding-rates')
    const allRates: LighterFundingRate[] = data.funding_rates || []
    return allRates.filter(fr => fr.exchange === 'lighter')
  }

  /**
   * Get market data from orderBookDetails + funding-rates
   */
  async getMarketData(marketIndex?: number): Promise<LighterMarketData[]> {
    // Fetch orderBookDetails and funding rates in parallel
    const [detailsData, fundingRates] = await Promise.all([
      this.get<any>('/api/v1/orderBookDetails'),
      this.getFundingRates(),
    ])

    const details: LighterOrderBookDetail[] = detailsData.order_book_details || []

    // Build funding rate lookup by market_id
    const fundingByMarketId = new Map<number, number>()
    for (const fr of fundingRates) {
      fundingByMarketId.set(fr.market_id, fr.rate)
    }

    const markets: LighterMarketData[] = []
    for (const d of details) {
      if (d.market_type !== 'perp') continue
      if (marketIndex !== undefined && d.market_id !== marketIndex) continue

      markets.push({
        market_id: d.market_id,
        symbol: d.symbol,
        mark_price: String(d.last_trade_price),
        index_price: String(d.last_trade_price),
        funding_rate: String(fundingByMarketId.get(d.market_id) ?? 0),
        open_interest: String(d.open_interest),
      })
    }

    return markets
  }

  /**
   * GET /api/v1/account?by=index&value={accountIndex}
   * Fetch detailed account info including positions.
   */
  async getAccount(accountIndex: number): Promise<LighterAccountInfo> {
    const data = await this.get<any>('/api/v1/account', { by: 'index', value: String(accountIndex) })
    const raw = data.accounts?.[0]
    if (!raw) throw new Error(`Account ${accountIndex} not found`)
    return {
      account_index: raw.index ?? raw.account_index ?? accountIndex,
      l1_address: raw.l1_address || '',
      balance: raw.collateral ?? '0',
      available_balance: raw.available_balance || '0',
      positions: raw.positions || [],
    }
  }

  /**
   * GET /api/v1/accountActiveOrders
   * List active (open) orders for an account, including pending TP/SL triggers.
   * `market_id=255` is Lighter's all-markets sentinel.
   */
  async getAccountActiveOrders(accountIndex: number, marketId: number = 255, authToken?: string): Promise<LighterActiveOrder[]> {
    const data = await this.get<any>(
      '/api/v1/accountActiveOrders',
      { account_index: String(accountIndex), market_id: String(marketId) },
      authToken,
    )
    return (data.orders || []) as LighterActiveOrder[]
  }

  /**
   * GET /api/v1/account?by=l1_address&value={address}
   * Fetch detailed account info including positions by ETH address.
   * Unlike accountsByL1Address, this endpoint returns full position data.
   */
  async getDetailedAccountByL1Address(l1Address: string): Promise<LighterAccountInfo | null> {
    try {
      const checksummed = getAddress(l1Address)
      const data = await this.get<any>('/api/v1/account', { by: 'l1_address', value: checksummed })
      const raw = data.accounts?.[0]
      if (!raw) return null
      return {
        account_index: raw.index ?? raw.account_index,
        l1_address: raw.l1_address || checksummed,
        balance: raw.collateral ?? '0',
        available_balance: raw.available_balance || '0',
        positions: raw.positions || [],
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('account not found')) {
        return null
      }
      throw error
    }
  }

  /**
   * GET /api/v1/accountsByL1Address
   * Fetch account by L1 (Ethereum) address.
   * Lighter requires EIP-55 checksummed addresses — this method handles that.
   * Normalizes the response fields to match LighterAccountInfo.
   */
  async getAccountByL1Address(l1Address: string): Promise<LighterAccountInfo | null> {
    try {
      // Lighter API requires EIP-55 checksummed address (case-sensitive)
      const checksummed = getAddress(l1Address)
      const data = await this.get<any>('/api/v1/accountsByL1Address', { l1_address: checksummed })
      const raw = data.sub_accounts?.[0]
      if (!raw) return null

      // Normalize response fields (API returns `index` and `collateral`, not `account_index` and `balance`)
      return {
        account_index: raw.index ?? raw.account_index,
        l1_address: raw.l1_address || checksummed,
        balance: raw.collateral ?? raw.balance ?? '0',
        available_balance: raw.available_balance || '0',
        positions: raw.positions || [],
      }
    } catch (error) {
      // 400 with "account not found" is expected when user hasn't deposited yet
      if (error instanceof Error && error.message.includes('account not found')) {
        return null
      }
      throw error
    }
  }

  /**
   * POST /api/v1/createIntentAddress (form-urlencoded)
   * Create a deposit intent address for Solana USDC deposits.
   * Returns a Solana token account address to transfer USDC to directly.
   *
   * @param fromAddr - L1 (Ethereum) address of the depositor
   * @param amount - Amount in USDC (e.g. 10)
   */
  async createIntentAddress(fromAddr: string, amount: number): Promise<{ intent_address: string }> {
    const body = new URLSearchParams({
      chain_id: '101',
      from_addr: fromAddr,
      amount: String(amount),
      is_external_deposit: 'true',
    })

    const response = await fetch(`${LIGHTER_BASE_URL}/api/v1/createIntentAddress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Lighter createIntentAddress failed ${response.status}: ${text}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Lighter createIntentAddress: invalid JSON: ${text.slice(0, 200)}`)
    }
  }

  /**
   * GET /api/v1/deposit/latest
   * Get the most recent deposit for a given L1 address.
   * Proxied directly to the frontend.
   */
  async getDepositLatest(l1Address: string): Promise<any> {
    return this.get('/api/v1/deposit/latest', { l1_address: l1Address })
  }

  // ==================== Fast Withdraw Endpoints ====================

  /**
   * GET /api/v1/fastwithdraw/info
   * Get fast withdraw pool info (destination account + limits)
   */
  async getFastWithdrawInfo(accountIndex: number, authToken: string): Promise<{ to_account_index: number; withdraw_limit: string }> {
    const url = new URL(`${LIGHTER_BASE_URL}/api/v1/fastwithdraw/info`)
    url.searchParams.set('account_index', String(accountIndex))

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authToken,
      },
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Lighter fastwithdraw/info failed ${response.status}: ${text}`)
    }

    const data = JSON.parse(text)
    if (data.code !== 200) {
      throw new Error(`Lighter fastwithdraw/info error: ${data.message || text}`)
    }
    return data
  }

  /**
   * GET /api/v1/transferFeeInfo
   * Get transfer fee for a transfer between two accounts
   */
  async getTransferFeeInfo(accountIndex: number, toAccountIndex: number, authToken: string): Promise<{ transfer_fee_usdc: number }> {
    const url = new URL(`${LIGHTER_BASE_URL}/api/v1/transferFeeInfo`)
    url.searchParams.set('account_index', String(accountIndex))
    url.searchParams.set('to_account_index', String(toAccountIndex))

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authToken,
      },
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Lighter transferFeeInfo failed ${response.status}: ${text}`)
    }

    return JSON.parse(text)
  }

  /**
   * POST /api/v1/fastwithdraw
   * Submit a fast withdrawal (form-encoded)
   */
  async submitFastWithdraw(txInfo: string, toAddress: string, authToken: string): Promise<{ code?: number; tx_hash?: string; message?: string }> {
    const form = new URLSearchParams()
    form.append('tx_info', txInfo)
    form.append('to_address', toAddress)

    const response = await fetch(`${LIGHTER_BASE_URL}/api/v1/fastwithdraw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': authToken,
      },
      body: form.toString(),
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Lighter fastwithdraw failed ${response.status}: ${text}`)
    }

    return JSON.parse(text)
  }

  // ==================== Trading Endpoints ====================

  /**
   * POST /api/v1/sendTx
   * Submit a signed transaction (form-encoded, as per Lighter API spec)
   */
  async sendTx(txType: number, txInfo: string): Promise<{ tx_hash?: string; error?: string }> {
    const form = new FormData()
    form.append('tx_type', String(txType))
    form.append('tx_info', txInfo)

    const response = await fetch(`${LIGHTER_BASE_URL}/api/v1/sendTx`, {
      method: 'POST',
      body: form,
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Lighter sendTx failed ${response.status}: ${text}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Lighter sendTx: invalid JSON: ${text.slice(0, 200)}`)
    }
  }

  /**
   * GET /api/v1/nextNonce
   * Get the next nonce for a given account + API key pair
   */
  async getNextNonce(accountIndex: number, apiKeyIndex: number): Promise<number> {
    const data = await this.get<{ nonce: number }>('/api/v1/nextNonce', {
      account_index: String(accountIndex),
      api_key_index: String(apiKeyIndex),
    })
    return data.nonce
  }

  /**
   * GET /api/v1/apikeys
   * Get registered API keys for an account
   */
  async getApiKeys(accountIndex: number, apiKeyIndex: number): Promise<{ api_keys: Array<{ public_key: string; api_key_index: number }> }> {
    return this.get('/api/v1/apikeys', {
      account_index: String(accountIndex),
      api_key_index: String(apiKeyIndex),
    })
  }

  // ==================== Funding History ====================

  /**
   * GET /api/v1/positionFunding
   * Get historical funding payments for an account.
   */
  async getPositionFunding(accountIndex: number, authToken: string, params?: { market?: number; limit?: number; cursor?: string }): Promise<LighterPositionFundingResponse> {
    const queryParams: Record<string, string> = {
      account_index: String(accountIndex),
    }
    if (params?.market !== undefined) queryParams.market = String(params.market)
    if (params?.limit !== undefined) queryParams.limit = String(params.limit)
    if (params?.cursor) queryParams.cursor = params.cursor
    return this.get('/api/v1/positionFunding', queryParams, authToken)
  }

  // ==================== Helpers ====================

  /**
   * Get market index for a symbol
   */
  getMarketIndex(symbol: string): number | undefined {
    return this.symbolToMarketIndex.get(symbol.toUpperCase())
  }

  /**
   * Get cached order book detail for a market
   */
  getOrderBookDetail(marketIndex: number): LighterOrderBookDetail | undefined {
    return this.marketCache.get(marketIndex)
  }

  /**
   * Get all cached order book details
   */
  getAllOrderBookDetails(): Map<number, LighterOrderBookDetail> {
    return this.marketCache
  }

  /**
   * Get symbol to market index mapping
   */
  getSymbolMap(): Map<string, number> {
    return this.symbolToMarketIndex
  }
}

export function createLighterClient(): LighterClient {
  return new LighterClient()
}
