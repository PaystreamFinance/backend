import type { RiskTag, RiskParams } from '@paystream/db/schema'
import type { FundingPayment } from '@paystream/perps/types'
import { isHip3ProtocolId, type Hip3ProtocolId } from '@paystream/perps/hip3/dex-config'

/**
 * =======================
 * ARB (ARBITRAGE) MODELS
 * =======================
 */

/**
 * Pacifica market info in response
 */
export interface ArbPacificaMarketInfo {
  fundingRate: string | null
  fundingRateApr: string | null
  openInterest: {
    long: number
    short: number
  } | null
  fees: {
    taker: string
    maker: string
  }
  oraclePrice: number
  maxLeverage: number | null
}

/**
 * Hyperliquid market info in response
 */
export interface ArbHyperliquidMarketInfo {
  fundingRate: string | null
  fundingRateApr: string | null
  openInterest: {
    long: number
    short: number
  } | null
  fees: {
    taker: string
    maker: string
  }
  oraclePrice: number
  maxLeverage: number | null
}

/**
 * Aster market info in response
 */
export interface ArbAsterMarketInfo {
  fundingRate: string | null
  fundingRateApr: string | null
  fees: {
    taker: string
    maker: string
  }
  oraclePrice: number
  maxLeverage: number | null
}

/**
 * Lighter market info in response
 */
export interface ArbLighterMarketInfo {
  fundingRate: string | null
  fundingRateApr: string | null
  fees: {
    taker: string
    maker: string
  }
  oraclePrice: number
  maxLeverage: number | null
}

/**
 * 01 Exchange market info in response
 */
export interface ArbZoMarketInfo {
  fundingRate: string | null
  fundingRateApr: string | null
  openInterest: {
    long: number
    short: number
  } | null
  fees: {
    taker: string
    maker: string
  }
  oraclePrice: number
  maxLeverage: number | null
}

/**
 * Arbitrage opportunity info
 */
export interface ArbOpportunity {
  spreadApr: number
  suggestedDirection: {
    pacifica: 'long' | 'short'
  }
}

/**
 * Combined market info for response
 */
export interface ArbMarketResponse {
  symbol: string
  pacifica: ArbPacificaMarketInfo | null
  hyperliquid: ArbHyperliquidMarketInfo | null
  aster: ArbAsterMarketInfo | null
  lighter: ArbLighterMarketInfo | null
  '01': ArbZoMarketInfo | null
  arbOpportunity: ArbOpportunity | null
}

/**
 * GET /api/arb/markets Success Response
 */
export interface ArbMarketsSuccessResponse {
  status: 'success'
  count: number
  markets: ArbMarketResponse[]
}

/**
 * GET /api/arb/markets Error Response
 */
export interface ArbMarketsErrorResponse {
  status: 'error'
  message: string
  error?: string
  details?: string
}

/**
 * Base (non-HIP-3) protocol types for arbitrage trading.
 */
export const ARB_BASE_PROTOCOLS = ['pacifica', 'hyperliquid', 'aster', 'lighter', '01', 'phoenix'] as const
export type ArbBaseProtocol = (typeof ARB_BASE_PROTOCOLS)[number]

/**
 * Full protocol union including HIP-3 protocol ids (`hl:<dexName>`).
 * Use `ARB_BASE_PROTOCOLS` when you specifically need the fixed enumerable
 * set; anywhere a user-provided protocol string is accepted, use `ArbProtocol`
 * and validate via `isArbProtocol`.
 */
export type ArbProtocol = ArbBaseProtocol | Hip3ProtocolId

/**
 * @deprecated Kept for back-compat with callers that iterate base protocols.
 * New code should import `ARB_BASE_PROTOCOLS` for iteration or use
 * `isArbProtocol` / `isHip3ProtocolId` for validation of arbitrary strings.
 */
export const ARB_PROTOCOLS = ARB_BASE_PROTOCOLS

export function isArbProtocol(value: unknown): value is ArbProtocol {
  return (
    typeof value === 'string' &&
    ((ARB_BASE_PROTOCOLS as readonly string[]).includes(value) || isHip3ProtocolId(value))
  )
}

/**
 * POST /api/arb/trade Request
 */
export interface ArbTradeRequest {
  market: string
  totalMarginUsd: number
  leverage: number
  protocols: {
    long: ArbProtocol
    short: ArbProtocol
  }
  /** Optional Jito bundle tip in SOL (default: 0.0001 SOL) */
  jitoFeeSol?: number
  disableAclp?: boolean
  /** Fully opt out of auto-close monitoring for this pair. */
  disableAutoclose?: boolean
}

/**
 * POST /api/arb/trade/v2 Request
 *
 * Unlike v1 (which takes a single normalized ticker for both legs), v2 accepts
 * distinct per-leg tickers so users can hedge across dexes that list the same
 * asset under different symbols (e.g. long `XAU` on Pacifica vs short `GOLD`
 * on Hyperliquid vs `PAXG` on Aster). The tickers are expected to be whatever
 * /markets returns for each dex column (already in that dex's native form).
 */
export interface ArbTradeV2Request {
  long: {
    dex: ArbProtocol
    ticker: string
  }
  short: {
    dex: ArbProtocol
    ticker: string
  }
  totalMarginUsd: number
  leverage: number
  /** Optional Jito bundle tip in SOL (default: 0.0001 SOL) */
  jitoFeeSol?: number
  disableAclp?: boolean
  /** Fully opt out of auto-close monitoring for this pair. */
  disableAutoclose?: boolean
}

/**
 * Per-leg result in trade response
 */
export interface ArbTradeLegResult {
  status: 'success' | 'error'
  direction: 'long' | 'short'
  margin: number
  notional: number
  txSignature?: string
  orderId?: number
  error?: string
}

/**
 * POST /api/arb/trade Success Response
 * status: 'success' = both legs confirmed
 * status: 'sent' = bundle sent but not yet confirmed
 * status: 'partial' = one leg succeeded, other failed (unhedged position!)
 */
export interface ArbTradeSuccessResponse {
  status: 'success' | 'sent' | 'partial'
  message: string
  positions: Partial<Record<ArbProtocol, ArbTradeLegResult>>
  fees: {
    total: number
  }
  bundleId?: string
  pairId?: number
}

/**
 * POST /api/arb/trade Error Response
 */
export interface ArbTradeErrorResponse {
  status: 'error'
  message: string
  error?: string
  details?: string
}

/**
 * Position info for unmatched (non-arb) positions
 */
export interface ArbPositionInfo {
  symbol: string
  direction: 'long' | 'short'
  size: {
    usd: number
    asset: number
  }
  pnl: number
  unrealizedPnl: number
  fundingIncome: number
  entryPrice: number
  leverage: number
  margin: number
  liquidationPrice?: number
  triggerPrices?: { tp?: number; sl?: number }
}

/**
 * Live position data fetched from protocol
 */
export interface ArbLiveData {
  size: { usd: number; asset: number }
  pnl: number
  unrealizedPnl: number
  fundingIncome: number
  entryPrice: number
  leverage: number
  margin: number
  liquidationPrice: number | null
  triggerPrices?: { tp?: number; sl?: number }
}

/**
 * A single leg (long or short) of a live arb position pair
 */
export interface ArbLivePositionLeg {
  protocol: ArbProtocol
  /** Per-leg ticker on this dex — may differ from the pair's shared `symbol`
   *  for cross-ticker pairs (e.g. XAU on Pacifica + GOLD on Hyperliquid). */
  symbol: string
  marginUsd: number
  notionalUsd: number
  leverage: number
  entryPrice: number | null
  txSignature: string | null
  live: ArbLiveData | null
}

export type ArbPairStatus = 'open' | 'closing' | 'closed' | 'liquidated' | 'error'

/**
 * An arb pair enriched with live position data and risk tags
 */
export interface ArbLivePositionPair {
  publicId: string
  symbol: string
  status: ArbPairStatus
  riskTag: RiskTag
  riskParams: RiskParams
  negFundingCount: number
  entryApy: number | null
  totalMarginUsd: number
  lastOraclePrice: number | null
  long: ArbLivePositionLeg
  short: ArbLivePositionLeg
  createdAt: string
  disableAclp: boolean
  survivingLegSlSet: boolean
  disableAutoclose: boolean
}

/**
 * GET /api/arb/positions Success Response (v1 — protocol-grouped)
 */
export interface ArbPositionsSuccessResponse {
  status: 'success'
  positions: Partial<Record<ArbProtocol, ArbPositionInfo[]>>
  totalPnl: number
}

/**
 * GET /api/arb/positions/v2 Success Response (pair-centric with risk tags)
 */
export interface ArbPositionsV2SuccessResponse {
  status: 'success'
  pairs: ArbLivePositionPair[]
  unmatched: Partial<Record<ArbProtocol, ArbPositionInfo[]>>
  totalPnl: number
}

/**
 * GET /api/arb/positions Error Response
 */
export interface ArbPositionsErrorResponse {
  status: 'error'
  message: string
  error?: string
  details?: string
}

export interface ArbTpSlLookupTarget {
  protocol: ArbProtocol
  market: string
}

export interface ArbTpSlLookupRequest {
  positions: ArbTpSlLookupTarget[]
}

export interface ArbTpSlLookupResult {
  protocol: ArbProtocol
  market: string
  status: 'success' | 'not_found' | 'error'
  direction?: 'long' | 'short'
  triggerPrices?: { tp?: number; sl?: number }
  error?: string
}

export interface ArbTpSlLookupSuccessResponse {
  status: 'success' | 'partial'
  results: ArbTpSlLookupResult[]
}

export interface ArbTpSlLookupErrorResponse {
  status: 'error'
  message: string
  error?: string
}

/**
 * POST /api/arb/close Request
 */
export interface ArbCloseRequest {
  /** Back-compat shared ticker. For cross-ticker pairs this is the long
   *  leg's ticker; prefer passing `pairId` so the server can look up per-leg
   *  tickers itself. */
  market: string
  protocols: ArbProtocol[]
  /** Optional Jito bundle tip in SOL (default: 0.0001 SOL) */
  jitoFeeSol?: number
  /** DB pair ID for updating arb_position_pairs on close. When provided, the
   *  server uses the pair's `long_symbol` / `short_symbol` for per-leg
   *  position lookup and close calls. */
  pairId?: number
  /** Public UUID for the pair (returned by /api/arb/positions/v2). Resolved to
   *  the internal `pairId` server-side. Prefer this over `pairId` from clients. */
  publicId?: string
}

/**
 * Close result for a single protocol
 */
export interface ArbClosePositionResult {
  txSignature: string
  pnl: number
}

/**
 * POST /api/arb/close Success Response
 * status: 'success' = confirmed, 'sent' = bundle sent but not yet confirmed
 */
export interface ArbCloseSuccessResponse {
  status: 'success' | 'sent'
  message: string
  closed: Partial<Record<ArbProtocol, ArbClosePositionResult>>
  totalPnl: number
  bundleId: string
}

/**
 * POST /api/arb/close Error Response
 */
export interface ArbCloseErrorResponse {
  status: 'error'
  message: string
  error?: string
  details?: string
}

/**
 * Per-protocol result in close-all response
 */
export interface ArbCloseAllProtocolResult {
  status: 'success' | 'error'
  closed: {
    symbol: string
    direction: 'long' | 'short'
    pnl: number
    orderId?: number
    txSignature?: string
  }[]
  error?: string
}

/**
 * POST /api/arb/close-all Success Response
 * status: 'success' = all closed, 'partial' = some failed
 */
export interface ArbCloseAllSuccessResponse {
  status: 'success' | 'partial'
  message: string
  results: Partial<Record<ArbProtocol, ArbCloseAllProtocolResult>>
  totalPnl: number
  bundleId?: string
}

/**
 * POST /api/arb/close-all Error Response
 */
export interface ArbCloseAllErrorResponse {
  status: 'error'
  message: string
  error?: string
  details?: string
}

/**
 * =======================
 * ARB ACTIVITY MODELS
 * =======================
 */

/**
 * A single position pair record for activity history
 */
export interface ArbActivityLeg {
  protocol: string
  /** Per-leg ticker on this dex — may differ from the pair's shared `symbol`
   *  for cross-ticker pairs. */
  symbol: string
  marginUsd: number
  notionalUsd: number
  leverage: number
  entryPrice: number | null
  liquidationPrice: number | null
  txSignature: string | null
  status: string
}

export interface ArbActivityPosition {
  publicId: string
  symbol: string
  status: string
  long: ArbActivityLeg
  short: ArbActivityLeg
  sizeAsset: number | null
  totalMarginUsd: number
  closeReason: string | null
  closeReasonLabel: string | null
  realizedPnl: number | null
  closeLongTx: string | null
  closeShortTx: string | null
  riskTag: string | null
  riskParams: { liqProximity: string; funding: string; oiCascade: string; equityDrawdown: string } | null
  negFundingCount: number | null
  createdAt: string
  closedAt: string | null
}

/**
 * Aggregate stats for all user positions (unfiltered by status)
 */
export interface ArbActivitySummary {
  totalPositions: number
  totalRealizedPnl: number
  countByStatus: {
    open: number
    closing: number
    closed: number
    liquidated: number
    error: number
  }
}

/**
 * GET /api/arb/activity Success Response
 */
export interface ArbActivitySuccessResponse {
  status: 'success'
  positions: ArbActivityPosition[]
  summary: ArbActivitySummary
  pagination: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
}

/**
 * GET /api/arb/activity Error Response
 */
export interface ArbActivityErrorResponse {
  status: 'error'
  message: string
  error?: string
}

/**
 * =======================
 * TRANSFER MODELS
 * =======================
 */

export type TransferType = 'deposit' | 'withdrawal'
export type TransferProtocol = 'pacifica' | 'hyperliquid' | 'aster' | 'lighter' | '01' | 'phoenix'
export type TransferStatus = 'initiated' | 'confirmed' | 'failed'

/**
 * A single transfer record for history
 */
export interface TransferRecord {
  publicId: string
  type: TransferType
  protocol: TransferProtocol
  asset: string
  amount: number
  usdcValue: number
  status: TransferStatus
  txHash: string | null
  fromAddress: string | null
  toAddress: string | null
  metadata: unknown
  createdAt: string
  updatedAt: string
}

/**
 * GET /api/arb/transfers Success Response
 */
export interface TransfersSuccessResponse {
  status: 'success'
  transfers: TransferRecord[]
  pagination: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
}

/**
 * GET /api/arb/transfers Error Response
 */
export interface TransfersErrorResponse {
  status: 'error'
  message: string
  error?: string
}

/**
 * =======================
 * FUNDING HISTORY MODELS
 * =======================
 */

/** Re-export for API response (same shape as FundingPayment from @paystream/perps) */
export type FundingPaymentEntry = FundingPayment

/**
 * GET /api/arb/activity/funding/history Success Response
 */
export interface ArbFundingHistorySuccessResponse {
  status: 'success'
  hyperliquid: FundingPaymentEntry[]
  pacifica: FundingPaymentEntry[]
  aster: FundingPaymentEntry[]
  lighter: FundingPaymentEntry[]
  '01': FundingPaymentEntry[]
  phoenix: FundingPaymentEntry[]
  /** HIP-3 per-dex funding payments, keyed by `hl:<dexName>`. */
  hip3: Partial<Record<Hip3ProtocolId, FundingPaymentEntry[]>>
  errors: Partial<Record<ArbProtocol, string>>
  /** Per-dex warnings (e.g. truncated results, unavailable history) */
  warnings: Partial<Record<ArbProtocol, string>>
  fundingEarned: number
  fundingPaid: number
  totalFundingUsd: number
}

/**
 * GET /api/arb/activity/funding/history Error Response
 */
export interface ArbFundingHistoryErrorResponse {
  status: 'error'
  message: string
  error?: string
}

/**
 * =======================
 * TP/SL MODELS
 * =======================
 */

export const TP_SL_TYPES = ['tp', 'sl'] as const
export type TpSlType = (typeof TP_SL_TYPES)[number]

/**
 * A single TP or SL target in the request.
 * Exactly one of `triggerPrice` or `triggerPricePercent` must be provided.
 *   - triggerPrice: absolute USD price where the trigger fires
 *   - triggerPricePercent: % distance from the position's entry price (always positive;
 *     sign is inferred from type + position direction). E.g. pct=5 with type='tp' on a
 *     long resolves to entry*1.05; pct=5 with type='sl' on a long resolves to entry*0.95.
 */
export interface TpSlTarget {
  protocol: ArbProtocol
  market: string                    // e.g. "SOL", "BTC"
  type: TpSlType                    // 'tp' = take-profit, 'sl' = stop-loss
  triggerPrice?: number             // Absolute trigger price
  triggerPricePercent?: number      // Entry-price-relative %, 0 < pct < 100
}

/**
 * POST /api/arb/set-tp-sl Request
 */
export interface ArbSetTpSlRequest {
  positions: TpSlTarget[]
}

/**
 * Per-position result in TP/SL response
 */
export interface TpSlResult {
  protocol: ArbProtocol
  market: string
  type: TpSlType
  /** Resolved absolute trigger price actually placed on the exchange. */
  triggerPrice: number
  /** Echoed when the caller supplied a percent-based input. */
  triggerPricePercent?: number
  /** Entry price used to resolve `triggerPrice` from a percent input. */
  entryPrice?: number
  status: 'success' | 'error'
  direction?: 'long' | 'short'
  error?: string
}

/**
 * POST /api/arb/set-tp-sl Success Response
 */
export interface ArbSetTpSlSuccessResponse {
  status: 'success' | 'partial'
  message: string
  results: TpSlResult[]
}

/**
 * POST /api/arb/set-tp-sl Error Response
 */
export interface ArbSetTpSlErrorResponse {
  status: 'error'
  message: string
  error?: string
}
