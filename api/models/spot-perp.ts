/**
 * =======================
 * SPOT-PERP HEDGE MODELS
 * =======================
 */

/**
 * Supported perp protocols for spot-perp hedge
 */
export type SpotPerpProtocol = 'pacifica' | 'hyperliquid' | 'aster' | 'lighter' | '01'

/**
 * POST /api/trade/spot-perp Request
 *
 * Flow:
 * 1. totalUsd / 2 -> Spot buy (USDC -> spotTokenMint via Jupiter)
 * 2. totalUsd / 2 -> Perp short on selected protocol
 *    perpMarginUsd = perpNotionalUsd / leverage
 */
export interface SpotPerpTradeRequest {
  totalUsd: number
  market: string
  perpProtocol: SpotPerpProtocol
  leverage: number
  spotTokenMint: string
  jitoFeeSol?: number
}

/**
 * POST /api/trade/spot-perp Success Response
 */
export interface SpotPerpTradeSuccessResponse {
  status: 'success' | 'partial'
  message: string
  data: {
    tradeId: number
    totalUsd: number
    spotUsd: number
    spotTxnHash: string
    spotAmount: string
    perpNotionalUsd: number
    perpMarginUsd: number
    perpLeverage: number
    perpProtocol: SpotPerpProtocol
    perpMarket: string
    perpTxnHash?: string
    perpOrderId?: number
    perpBundleId?: string
    perpError?: string
    ethAddress?: string
  }
}

/**
 * POST /api/trade/spot-perp Error Response
 */
export interface SpotPerpTradeErrorResponse {
  status: 'error'
  message: string
  error?: string
  details?: string
}

/**
 * Position info combining DB record with live perp data
 */
export interface SpotPerpPositionInfo {
  tradeId: number
  market: string
  spotTokenMint: string
  perpProtocol: SpotPerpProtocol
  totalUsd: number
  spotUsd: number
  spotAmount: string | null
  spotTxnHash: string | null
  perpMarginUsd: number
  perpNotionalUsd: number
  perpLeverage: number
  perpTxnHash: string | null
  perpOrderId: number | null
  createdAt: string
  // Live perp data
  perpPosition: {
    sizeUsd: number
    pnl: number
    entryPrice: number
  } | null
}

/**
 * GET /api/trade/spot-perp/positions Success Response
 */
export interface SpotPerpPositionsSuccessResponse {
  status: 'success'
  positions: SpotPerpPositionInfo[]
  totalPerpPnl: number
}

/**
 * GET /api/trade/spot-perp/positions Error Response
 */
export interface SpotPerpPositionsErrorResponse {
  status: 'error'
  message: string
  error?: string
  details?: string
}

/**
 * POST /api/trade/spot-perp/close Request
 */
export interface SpotPerpCloseRequest {
  tradeId: number
}

/**
 * POST /api/trade/spot-perp/close Success Response
 */
export interface SpotPerpCloseSuccessResponse {
  status: 'success' | 'partial'
  message: string
  data: {
    tradeId: number
    closeSpotTxnHash?: string
    closePerpTxnHash?: string
    closePerpOrderId?: number
    spotError?: string
    perpError?: string
  }
}

/**
 * POST /api/trade/spot-perp/close Error Response
 */
export interface SpotPerpCloseErrorResponse {
  status: 'error'
  message: string
  error?: string
  details?: string
}
