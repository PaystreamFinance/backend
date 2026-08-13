import { log } from '../logger'
import * as hl from '@nktkas/hyperliquid'
import { formatPrice as hlFormatPrice, formatSize as hlFormatSize } from '@nktkas/hyperliquid/utils'
import type { LocalAccount } from 'viem'

// Hyperliquid API endpoints
const HYPERLIQUID_MAINNET = 'https://api.hyperliquid.xyz'
const HYPERLIQUID_TESTNET = 'https://api.hyperliquid-testnet.xyz'

/**
 * Hyperliquid meta information
 */
export interface HyperliquidMeta {
  universe: HyperliquidAssetMeta[]
}

export interface HyperliquidAssetMeta {
  name: string
  szDecimals: number
  maxLeverage: number
  onlyIsolated?: boolean
}

/**
 * Hyperliquid clearinghouse state (user account state)
 */
export interface HyperliquidClearinghouseState {
  assetPositions: HyperliquidAssetPosition[]
  crossMarginSummary: {
    accountValue: string
    totalNtlPos: string
    totalRawUsd: string
    totalMarginUsed: string
  }
  marginSummary: {
    accountValue: string
    totalNtlPos: string
    totalRawUsd: string
    totalMarginUsed: string
  }
  withdrawable: string
}

export interface HyperliquidAssetPosition {
  position: {
    coin: string
    szi: string
    leverage: {
      type: string
      value: number
    }
    entryPx: string
    positionValue: string
    unrealizedPnl: string
    returnOnEquity: string
    liquidationPx: string | null
    marginUsed: string
    cumFunding: {
      allTime: string
      sinceChange: string
      sinceOpen: string
    }
  }
  type: string
}

/**
 * Hyperliquid order parameters
 */
export interface HyperliquidOrderParams {
  asset: number // Asset index
  isBuy: boolean
  limitPx: string // Price as string (no trailing zeros)
  sz: string // Size as string (no trailing zeros)
  reduceOnly: boolean
  orderType: { limit: { tif: 'Gtc' | 'Ioc' | 'Alo' } } | { trigger: { triggerPx: string; isMarket: boolean; tpsl: 'tp' | 'sl' } }
  cloid?: string // Optional client order ID
}

/**
 * Hyperliquid order response
 */
export interface HyperliquidOrderResponse {
  status: 'ok' | 'err'
  response?: {
    type: string
    data?: {
      statuses: Array<{
        resting?: { oid: number }
        filled?: { totalSz: string; avgPx: string; oid: number }
        error?: string
      }>
    }
  }
}

/**
 * Funding rate history entry
 */
export interface HyperliquidFundingHistory {
  coin: string
  fundingRate: string
  premium: string
  time: number
}

/**
 * User funding payment entry from userFunding info endpoint
 */
/**
 * Open order from info type 'frontendOpenOrders'. For TP/SL triggers,
 * `orderType` is "Take Profit Market" / "Stop Market" (or _Limit) and
 * `triggerPx` is the trigger price.
 */
export interface HyperliquidFrontendOpenOrder {
  coin: string
  side: 'A' | 'B'
  limitPx: string
  sz: string
  oid: number
  timestamp: number
  triggerCondition: string
  isTrigger: boolean
  triggerPx: string
  isPositionTpsl: boolean
  reduceOnly: boolean
  orderType: string
  origSz: string
  tif: string | null
  cloid: string | null
}

export interface HyperliquidUserFundingEntry {
  delta: {
    coin: string
    fundingRate: string
    szi: string
    type: string
    usdc: string
  }
  hash: string
  time: number
}

/**
 * Asset context from metaAndAssetCtxs endpoint
 */
export interface HyperliquidAssetCtx {
  funding: string
  openInterest: string
  prevDayPx: string
  dayNtlVlm: string
  premium: string
  oraclePx: string
  markPx: string
  midPx: string
  impactPxs: [string, string]
}

/**
 * User fee info from userFees endpoint
 */
export interface HyperliquidUserFees {
  userCrossRate: string
  userAddRate: string
  activeReferralDiscount: string
  activeStakingDiscount?: string
  feeSchedule?: {
    name: string
    [key: string]: any
  }
  [key: string]: any
}

/**
 * HIP-3 perp dex metadata from the `perpDexs` info endpoint.
 * Index 0 of the perpDexs response is null (the main validator USDC perp);
 * subsequent entries match this shape.
 */
export interface HyperliquidPerpDex {
  name: string                         // short id used as the `dex` prefix, e.g. "xyz"
  fullName: string
  deployer: string
  oracleUpdater: string | null
  feeRecipient: string | null
  assetToStreamingOiCap: [string, string][]
  subDeployers: [string, string[]][]
  deployerFeeScale?: string
  lastDeployerFeeScaleChangeTime?: string
  assetToFundingMultiplier?: [string, string][]
  assetToFundingInterestRate?: [string, string][]
}

/**
 * Spot meta information
 */
export interface HyperliquidSpotMeta {
  universe: {
    tokens: number[]
    name: string
    index: number
    isCanonical: boolean
  }[]
  tokens: {
    name: string
    szDecimals: number
    weiDecimals: number
    index: number
    tokenId: string
    isCanonical: boolean
    fullName: string | null
  }[]
}

/**
 * Spot clearinghouse state (user spot balances)
 */
export interface HyperliquidSpotClearinghouseState {
  balances: {
    coin: string
    token: number
    total: string
    hold: string
    entryNtl: string
  }[]
}

/**
 * EIP-712 typed data for signing (kept for compatibility)
 */
export interface EIP712TypedData {
  domain: {
    name: string
    version: string
    chainId: number
    verifyingContract: string
  }
  types: Record<string, Array<{ name: string; type: string }>>
  primaryType: string
  message: Record<string, any>
}

/**
 * Signature type returned from signing
 */
export interface HyperliquidSignature {
  r: string
  s: string
  v: number
}

/**
 * Type for sign function (kept for compatibility)
 */
export type SignTypedDataFn = (typedData: EIP712TypedData) => Promise<HyperliquidSignature>

/**
 * Format price string for Hyperliquid according to tick size rules
 * Uses the SDK's formatPrice which handles:
 * - Maximum 5 significant figures
 * - Maximum (6 - szDecimals) decimal places for perps, (8 - szDecimals) for spot
 */
export function formatHyperliquidPrice(price: number, szDecimals: number = 0, type: 'perp' | 'spot' = 'perp'): string {
  try {
    return hlFormatPrice(price, szDecimals, type)
  } catch (error) {
    // Fallback to simple formatting if SDK throws
    log.warn(`[hl-client] formatPrice error, using fallback: ${error}`)
    const maxDecimals = Math.max((type === 'spot' ? 8 : 6) - szDecimals, 0)
    const str = price.toFixed(maxDecimals)
    return str.replace(/\.?0+$/, '') || '0'
  }
}

/**
 * Format size string for Hyperliquid according to lot size rules
 * Uses the SDK's formatSize which truncates to szDecimals
 */
export function formatHyperliquidSize(size: number, szDecimals: number): string {
  try {
    return hlFormatSize(size, szDecimals)
  } catch (error) {
    // Fallback: truncate (not round) to szDecimals
    log.warn(`[hl-client] formatSize error, using fallback: ${error}`)
    const factor = 10 ** szDecimals
    const truncated = Math.floor(size * factor) / factor
    const str = truncated.toFixed(szDecimals)
    return str.replace(/\.?0+$/, '') || '0'
  }
}

/**
 * Hyperliquid API client for trading operations
 * Uses @nktkas/hyperliquid SDK for proper EIP-712 signing
 */
export class HyperliquidClient {
  private baseUrl: string
  private ethAddress: string
  private isTestnet: boolean
  private viemAccount: LocalAccount | null = null
  private transport: hl.HttpTransport | null = null
  private exchangeClient: hl.ExchangeClient | null = null

  // Cache of symbol → "SYMBOL:<tokenId>" lookups built lazily from spotMeta.
  // tokenId values are immutable once a spot token is deployed, so an
  // unlimited TTL is safe; we only populate on first use.
  private spotTokenCache: Map<string, string> | null = null

  constructor(ethAddress: string, testnet: boolean = false) {
    this.baseUrl = testnet ? HYPERLIQUID_TESTNET : HYPERLIQUID_MAINNET
    this.ethAddress = ethAddress.toLowerCase()
    this.isTestnet = testnet
  }

  /**
   * Set the viem account for signing
   * This account should be created via Privy's createViemAccount
   */
  setViemAccount(account: LocalAccount): void {
    this.viemAccount = account

    // Create transport and exchange client with the account
    this.transport = new hl.HttpTransport({
      apiUrl: this.baseUrl,
      isTestnet: this.isTestnet
    })
    this.exchangeClient = new hl.ExchangeClient({
      transport: this.transport,
      wallet: account,
    })

    log.info(`[hl-client] Viem account set: ${account.address}`)
  }

  /**
   * Legacy method for compatibility - converts to viem account internally
   * @deprecated Use setViemAccount instead
   */
  setSignTypedData(signFn: SignTypedDataFn): void {
    // This method is kept for backward compatibility
    // But we now prefer setViemAccount which uses the SDK properly
    log.warn('[hl-client] setSignTypedData is deprecated, use setViemAccount instead')
  }

  /**
   * Fetch with timeout helper
   */
  private async fetchWithTimeout(url: string, timeoutMs: number = 10000, options?: RequestInit): Promise<Response> {
    return Promise.race([
      fetch(url, options),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error(`Fetch timeout after ${timeoutMs}ms: ${url}`)), timeoutMs)
      )
    ])
  }

  /**
   * POST to info endpoint
   */
  private async postInfo<T>(data: Record<string, any>): Promise<T> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/info`, 10000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw new Error(`Hyperliquid info request failed: ${response.status}`)
    }

    return response.json()
  }

  // ==================== Info Endpoints ====================

  /**
   * Get perpetual metadata (asset info, max leverage, etc.).
   * Pass a HIP-3 dex name (e.g. "xyz") to target a builder-deployed perp dex.
   */
  async getMeta(dex: string = ''): Promise<HyperliquidMeta> {
    return this.postInfo(dex ? { type: 'meta', dex } : { type: 'meta' })
  }

  /**
   * List all perpetual dexes — index 0 is null (main validator USDC perp),
   * subsequent entries are HIP-3 builder-deployed dexes.
   */
  async getPerpDexs(): Promise<Array<HyperliquidPerpDex | null>> {
    return this.postInfo({ type: 'perpDexs' })
  }

  /**
   * Get user's clearinghouse state (positions, margin, etc.).
   * Pass a HIP-3 dex name to query positions on that builder-deployed perp dex.
   */
  async getClearinghouseState(user?: string, dex: string = ''): Promise<HyperliquidClearinghouseState> {
    const body: Record<string, unknown> = {
      type: 'clearinghouseState',
      user: user || this.ethAddress,
    }
    if (dex) body.dex = dex
    return this.postInfo(body)
  }

  /**
   * Get all mid prices. For HIP-3, prices are keyed by prefixed coin name
   * (e.g. "xyz:XYZ100"), and the dex param filters to that dex's universe.
   */
  async getAllMids(dex: string = ''): Promise<Record<string, string>> {
    return this.postInfo(dex ? { type: 'allMids', dex } : { type: 'allMids' })
  }

  /**
   * Get open orders for user
   */
  async getOpenOrders(user?: string): Promise<any[]> {
    return this.postInfo({
      type: 'openOrders',
      user: user || this.ethAddress,
    })
  }

  /**
   * Get open orders with extra fields (orderType, triggerPx, isPositionTpsl, etc.).
   * Used to read currently-set TP/SL trigger orders attached to positions.
   * Pass a HIP-3 dex name to scope to that dex's universe.
   */
  async getFrontendOpenOrders(user?: string, dex: string = ''): Promise<HyperliquidFrontendOpenOrder[]> {
    const data: any = {
      type: 'frontendOpenOrders',
      user: user || this.ethAddress,
    }
    if (dex) data.dex = dex
    return this.postInfo(data)
  }

  /**
   * Get funding history for a coin. For HIP-3 markets, pass the prefixed coin
   * name (e.g. "xyz:XYZ100") — this endpoint does NOT accept a separate `dex`
   * parameter, the prefix on the coin is what routes to the HIP-3 universe.
   */
  async getFundingHistory(coin: string, startTime?: number, endTime?: number): Promise<HyperliquidFundingHistory[]> {
    const data: any = { type: 'fundingHistory', coin }
    if (startTime) data.startTime = startTime
    if (endTime) data.endTime = endTime
    return this.postInfo(data)
  }

  /**
   * Get user funding payments history.
   * Pass a HIP-3 dex name to scope the payments to that dex's positions.
   */
  async getUserFunding(user?: string, startTime?: number, endTime?: number, dex: string = ''): Promise<HyperliquidUserFundingEntry[]> {
    const data: any = {
      type: 'userFunding',
      user: user || this.ethAddress,
    }
    if (startTime) data.startTime = startTime
    if (endTime) data.endTime = endTime
    if (dex) data.dex = dex
    return this.postInfo(data)
  }

  /**
   * Get user fills (trade history)
   */
  async getUserFills(user?: string, startTime?: number): Promise<any[]> {
    const data: any = {
      type: 'userFills',
      user: user || this.ethAddress,
    }
    if (startTime) data.startTime = startTime
    return this.postInfo(data)
  }

  /**
   * Get user fee rates (tier, taker/maker rates, discounts)
   */
  async getUserFees(user?: string): Promise<HyperliquidUserFees> {
    return this.postInfo({
      type: 'userFees',
      user: user || this.ethAddress,
    })
  }

  /**
   * Get meta and all mids in one request
   */
  async getMetaAndAllMids(): Promise<[HyperliquidMeta, Record<string, string>]> {
    const [meta, mids] = await Promise.all([
      this.getMeta(),
      this.getAllMids(),
    ])
    return [meta, mids]
  }

  /**
   * Get meta and asset contexts (includes current funding rates for all assets).
   * Pass a HIP-3 dex name to get that dex's universe.
   */
  async getMetaAndAssetCtxs(dex: string = ''): Promise<[HyperliquidMeta, HyperliquidAssetCtx[]]> {
    const body: Record<string, unknown> = { type: 'metaAndAssetCtxs' }
    if (dex) body.dex = dex
    const result = await this.postInfo<[HyperliquidMeta, HyperliquidAssetCtx[]]>(body)
    return result
  }

  /**
   * Get predicted funding rates for all perp assets across venues.
   * Returns [coin, [venue, {fundingRate, nextFundingTime, fundingIntervalHours}][]][]
   * Filter for 'HlPerp' venue to get Hyperliquid-native data.
   */
  async getPredictedFundings(): Promise<
    [string, [string, { fundingRate: string; nextFundingTime: number; fundingIntervalHours: number } | null][]][]
  > {
    return this.postInfo({ type: 'predictedFundings' })
  }

  // ==================== Spot Info Endpoints ====================

  /**
   * Get spot metadata (token info, universe pairs)
   */
  async getSpotMeta(): Promise<HyperliquidSpotMeta> {
    return this.postInfo({ type: 'spotMeta' })
  }

  /**
   * Get user's spot clearinghouse state (spot balances)
   */
  async getSpotClearinghouseState(user?: string): Promise<HyperliquidSpotClearinghouseState> {
    return this.postInfo({
      type: 'spotClearinghouseState',
      user: user || this.ethAddress,
    })
  }

  /**
   * Get spot meta and asset contexts (includes mid prices for spot pairs)
   */
  async getSpotMetaAndAssetCtxs(): Promise<[HyperliquidSpotMeta, { dayNtlVlm: string; markPx: string; midPx: string; prevDayPx: string }[]]> {
    return this.postInfo({ type: 'spotMetaAndAssetCtxs' })
  }

  // ==================== Exchange Endpoints (using SDK) ====================

  /**
   * Place an order using the SDK
   */
  async placeOrder(params: HyperliquidOrderParams, grouping: 'na' | 'normalTpsl' | 'positionTpsl' = 'na'): Promise<HyperliquidOrderResponse> {
    if (!this.exchangeClient) {
      throw new Error('Exchange client not initialized. Call setViemAccount first.')
    }

    log.info(`[hl-client] Placing order via SDK: asset=${params.asset}, buy=${params.isBuy}, size=${params.sz}, price=${params.limitPx}, grouping=${grouping}`)

    try {
      const result = await this.exchangeClient.order({
        orders: [{
          a: params.asset,
          b: params.isBuy,
          p: params.limitPx,
          s: params.sz,
          r: params.reduceOnly,
          t: params.orderType as any,
        }],
        grouping,
      })

      log.info(`[hl-client] Order result: ${JSON.stringify(result)}`)

      return {
        status: 'ok',
        response: {
          type: 'order',
          data: {
            statuses: result.response.data.statuses.map((s: any) => {
              if (typeof s === 'string') {
                return { error: s }
              }
              if ('error' in s) {
                return { error: s.error }
              }
              if ('filled' in s) {
                return {
                  filled: {
                    totalSz: s.filled.totalSz,
                    avgPx: s.filled.avgPx,
                    oid: s.filled.oid,
                  }
                }
              }
              if ('resting' in s) {
                return {
                  resting: {
                    oid: s.resting.oid,
                  }
                }
              }
              return {}
            }),
          },
        },
      }
    } catch (error) {
      log.error(`[hl-client] Order failed:`, error)
      throw error
    }
  }

  /**
   * Place a market order (using IOC with slippage)
   * @param asset - Asset index
   * @param isBuy - True for buy, false for sell
   * @param size - Size formatted for Hyperliquid
   * @param currentPrice - Current market price
   * @param szDecimals - Size decimals for the asset (used for price formatting)
   * @param slippagePct - Slippage percentage (default 1%)
   */
  async placeMarketOrder(
    asset: number,
    isBuy: boolean,
    size: string,
    currentPrice: number,
    szDecimals: number,
    slippagePct: number = 1
  ): Promise<HyperliquidOrderResponse> {
    // For market orders, use IOC with slippage
    const slippageMultiplier = isBuy ? (1 + slippagePct / 100) : (1 - slippagePct / 100)
    const limitPrice = currentPrice * slippageMultiplier
    const formattedPrice = formatHyperliquidPrice(limitPrice, szDecimals)

    log.info(`[hl-client] Market order price formatting: raw=${limitPrice}, szDecimals=${szDecimals}, formatted=${formattedPrice}`)

    return this.placeOrder({
      asset,
      isBuy,
      limitPx: formattedPrice,
      sz: size,
      reduceOnly: false,
      orderType: { limit: { tif: 'Ioc' } },
    })
  }

  /**
   * Cancel an order using the SDK
   */
  async cancelOrder(asset: number, oid: number): Promise<any> {
    if (!this.exchangeClient) {
      throw new Error('Exchange client not initialized. Call setViemAccount first.')
    }

    const result = await this.exchangeClient.cancel({
      cancels: [{ a: asset, o: oid }],
    })

    return result
  }

  /**
   * Update leverage for an asset using the SDK
   */
  async updateLeverage(asset: number, leverage: number, isCross: boolean = true): Promise<any> {
    if (!this.exchangeClient) {
      throw new Error('Exchange client not initialized. Call setViemAccount first.')
    }

    log.info(`[hl-client] Updating leverage via SDK: asset=${asset}, leverage=${leverage}, isCross=${isCross}`)

    const result = await this.exchangeClient.updateLeverage({
      asset,
      isCross,
      leverage: Math.floor(leverage),
    })

    log.info(`[hl-client] Leverage update result: ${JSON.stringify(result)}`)
    return result
  }

  /**
   * Update isolated margin for a position using the SDK
   */
  async updateIsolatedMargin(asset: number, isBuy: boolean, amount: number): Promise<any> {
    if (!this.exchangeClient) {
      throw new Error('Exchange client not initialized. Call setViemAccount first.')
    }

    const result = await this.exchangeClient.updateIsolatedMargin({
      asset,
      isBuy,
      ntli: amount,
    })

    return result
  }

  /**
   * Transfer USDC between spot and perp wallets
   * @param amount - Amount in USD (e.g. "10.5" for $10.50)
   * @param toPerp - true to move spot → perp, false for perp → spot
   */
  async usdClassTransfer(amount: string, toPerp: boolean): Promise<any> {
    if (!this.exchangeClient) {
      throw new Error('Exchange client not initialized. Call setViemAccount first.')
    }

    log.info(`[hl-client] USD class transfer: amount=${amount}, toPerp=${toPerp}`)

    const result = await this.exchangeClient.usdClassTransfer({
      amount,
      toPerp,
    })

    log.info(`[hl-client] USD class transfer result: ${JSON.stringify(result)}`)
    return result
  }

  /**
   * Withdraw USDC from Hyperliquid to user's own ETH address (Arbitrum)
   * @param amount - Amount in USD (e.g. "10.5" for $10.50)
   * @param destination - Optional destination address (defaults to user's own address)
   */
  async withdraw(amount: string, destination?: string): Promise<any> {
    if (!this.exchangeClient) {
      throw new Error('Exchange client not initialized. Call setViemAccount first.')
    }

    const dest = (destination || this.ethAddress) as `0x${string}`
    log.info(`[hl-client] Withdrawing ${amount} USDC to ${dest}`)

    const result = await this.exchangeClient.withdraw3({
      destination: dest,
      amount,
    })

    log.info(`[hl-client] Withdraw result: ${JSON.stringify(result)}`)
    return result
  }

  /**
   * Resolve a spot symbol (e.g. "USDC", "USDH") to the
   * `SYMBOL:<tokenId>` identifier required by `sendAsset` and `spotSend`.
   * Caches spotMeta tokens on first use.
   */
  async resolveSpotTokenId(symbol: string): Promise<string> {
    if (!this.spotTokenCache) {
      const meta = await this.getSpotMeta()
      const cache = new Map<string, string>()
      for (const token of meta.tokens) {
        cache.set(token.name.toUpperCase(), `${token.name}:${token.tokenId}`)
      }
      this.spotTokenCache = cache
    }
    const id = this.spotTokenCache.get(symbol.toUpperCase())
    if (!id) {
      throw new Error(`Spot token "${symbol}" not found in Hyperliquid spotMeta`)
    }
    return id
  }

  /**
   * Unified transfer between spot and any perp dex (including HIP-3).
   *
   * @param params.sourceDex       "" for main USDC perp, "spot" for spot wallet, or a HIP-3 dex name (e.g. "xyz").
   * @param params.destinationDex  Same domain as sourceDex.
   * @param params.token           "SYMBOL:<tokenId>" — use {@link resolveSpotTokenId} to build it.
   * @param params.amount          Plain decimal string (NOT wei), e.g. "10.5".
   * @param params.destination     Recipient 0x address; defaults to the signer's own address (self-transfer).
   */
  async sendAsset(params: {
    sourceDex: string
    destinationDex: string
    token: string
    amount: string
    destination?: string
  }): Promise<any> {
    if (!this.exchangeClient) {
      throw new Error('Exchange client not initialized. Call setViemAccount first.')
    }

    const destination = (params.destination || this.ethAddress) as `0x${string}`
    log.info(
      `[hl-client] sendAsset: ${params.amount} ${params.token} from "${params.sourceDex}" → "${params.destinationDex}" (dest=${destination})`,
    )

    const result = await this.exchangeClient.sendAsset({
      destination,
      sourceDex: params.sourceDex,
      destinationDex: params.destinationDex,
      token: params.token,
      amount: params.amount,
      fromSubAccount: '',
    })

    log.info(`[hl-client] sendAsset result: ${JSON.stringify(result)}`)
    return result
  }

  /**
   * Send spot tokens to another address on Hyperliquid
   * Used for sending USOL to Unit withdraw address
   * @param destination - Recipient 0x address on Hyperliquid
   * @param token - Token identifier (e.g. tokenId from spotMeta)
   * @param amount - Amount to send (not in wei)
   */
  async spotSend(destination: string, token: string, amount: string): Promise<any> {
    if (!this.exchangeClient) {
      throw new Error('Exchange client not initialized. Call setViemAccount first.')
    }

    log.info(`[hl-client] Spot send: ${amount} of token=${token} to ${destination}`)

    const result = await this.exchangeClient.spotSend({
      destination: destination as `0x${string}`,
      token,
      amount,
    })

    log.info(`[hl-client] Spot send result: ${JSON.stringify(result)}`)
    return result
  }

  /**
   * Place a spot market order (using IOC with slippage)
   * @param spotAssetIndex - Index from spotMeta.universe (NOT 10000 + index, that's added internally)
   * @param isBuy - True for buy, false for sell
   * @param size - Size formatted for Hyperliquid
   * @param currentPrice - Current market price
   * @param szDecimals - Size decimals for the asset
   * @param slippagePct - Slippage percentage (default 2% for spot)
   */
  async placeSpotMarketOrder(
    spotAssetIndex: number,
    isBuy: boolean,
    size: string,
    currentPrice: number,
    szDecimals: number,
    slippagePct: number = 2
  ): Promise<HyperliquidOrderResponse> {
    const asset = 10000 + spotAssetIndex
    const slippageMultiplier = isBuy ? (1 + slippagePct / 100) : (1 - slippagePct / 100)
    const limitPrice = currentPrice * slippageMultiplier
    const formattedPrice = formatHyperliquidPrice(limitPrice, szDecimals, 'spot')

    log.info(`[hl-client] Spot market order: asset=${asset}, buy=${isBuy}, size=${size}, price=${formattedPrice} (raw=${limitPrice})`)

    return this.placeOrder({
      asset,
      isBuy,
      limitPx: formattedPrice,
      sz: size,
      reduceOnly: false,
      orderType: { limit: { tif: 'Ioc' } },
    })
  }
}

/**
 * Create a Hyperliquid client instance
 */
export function createHyperliquidClient(ethAddress: string, testnet: boolean = false): HyperliquidClient {
  return new HyperliquidClient(ethAddress, testnet)
}
