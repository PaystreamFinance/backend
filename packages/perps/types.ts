import type { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'

/**
 * Provider interface for arbitrage trading protocols
 * Each protocol (Pacifica, Hyperliquid, Aster, Lighter) implements this interface
 */
export interface IArbProvider {
  /** Protocol name (e.g., 'pacifica', 'aster') */
  name: string

  /** Initialize the provider and subscribe to data */
  initialize(): Promise<void>

  /** Get market info for a specific symbol */
  getMarketInfo(symbol: string): Promise<ArbMarketInfo | null>

  /** Get all available markets */
  getAllMarkets(): Promise<ArbMarketInfo[]>

  /** Get fee structure for a market */
  getFees(symbol: string): Promise<ArbFeeInfo>

  /** Build transaction to open a position */
  buildOpenPositionTransaction(
    params: OpenPositionParams,
    wallet: PublicKey
  ): Promise<OpenPositionResult>

  /** Build transaction to close a position */
  buildClosePositionTransaction(
    symbol: string,
    direction: 'long' | 'short',
    wallet: PublicKey
  ): Promise<ClosePositionResult>

  /** Get user's open positions */
  getPositions(wallet: PublicKey, options?: GetPositionsOptions): Promise<ArbPosition[]>

  /** Cleanup and unsubscribe */
  cleanup(): Promise<void>
}

export interface GetPositionsOptions {
  /** Whether to enrich positions with TP/SL trigger prices from open orders. */
  includeTriggerPrices?: boolean
}

/**
 * Market info from a provider
 */
export interface ArbMarketInfo {
  symbol: string
  marketIndex?: number
  marketId?: { symbol: string; pool: string }
  fundingRate?: number
  fundingRateApr?: number
  openInterest?: {
    long: number
    short: number
  }
  oraclePrice: number
  /** Mark price — the price the exchange uses for PnL and liquidations. */
  markPrice?: number
  /** Index price — the off-chain oracle reference the exchange tracks. */
  indexPrice?: number
  maxLeverage?: number
  fundingIntervalHours?: number  // 1, 2, 4, or 8
  nextFundingTime?: number       // Unix timestamp in ms
}

/**
 * Fee info from a provider
 */
export interface ArbFeeInfo {
  /** Taker fee in basis points (e.g., 3.5 = 0.035%) */
  takerFeeBps?: number
  /** Maker fee in basis points (can be negative for rebates) */
  makerFeeBps?: number
  /** Opening fee in basis points */
  openFeeBps?: number
  /** Margin fee per hour in basis points */
  marginFeePerHourBps?: number
}

/**
 * Parameters for opening a position
 */
export interface OpenPositionParams {
  symbol: string
  marginUsd: number
  leverage: number
  direction: 'long' | 'short'
  /** Target size in asset units. When provided, providers use this directly instead of computing from marginUsd. Used to ensure both legs of an arb have matching sizes. */
  sizeAsset?: number
}

/**
 * Result of building an open position transaction
 */
export interface OpenPositionResult {
  transaction: Transaction | VersionedTransaction
  additionalSigners?: any[]
  addressLookupTables?: any[]
  marketIndex?: number
  direction: 'long' | 'short'
  notionalUsd: number
  marginUsd: number
  estimatedFees: number
  oraclePrice: number
  entryPrice: number
}

/**
 * Result of building a close position transaction
 */
export interface ClosePositionResult {
  transaction: Transaction | VersionedTransaction
  additionalSigners?: any[]
  addressLookupTables?: any[]
  direction: 'long' | 'short'
  symbol: string
}

/**
 * Position info from a provider
 */
export interface ArbPosition {
  symbol: string
  direction: 'long' | 'short'
  sizeUsd: number
  sizeAsset: number
  pnl: number
  unrealizedPnl: number
  fundingIncome: number
  entryPrice: number
  leverage: number
  margin: number
  liquidationPrice?: number
  marketIndex?: number
  poolName?: string
  triggerPrices?: { tp?: number; sl?: number }
}

/**
 * A single funding payment entry from a DEX
 * All amounts are in USD (USDC/USDT depending on exchange)
 */
export interface FundingPayment {
  /** Base asset symbol, e.g. "SOL", "BTC" */
  symbol: string
  /** USD amount — positive = earned, negative = paid */
  amount: number
  /** Funding rate at time of payment */
  rate: number
  /** Timestamp in milliseconds */
  timestamp: number
  /** Position direction that generated this payment (unavailable on some exchanges) */
  direction?: 'long' | 'short'
}

/**
 * Result of fetching funding payments from a provider.
 * Includes a truncated flag when the provider hit its pagination limit
 * and the returned data is incomplete.
 */
export interface FundingPaymentsResult {
  payments: FundingPayment[]
  /** True if the result was capped by a pagination/safety limit and more data exists */
  truncated: boolean
}
