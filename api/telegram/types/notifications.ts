export enum NotificationType {
  LIQUIDATION_WARNING = 'liquidation_warning',
  AUTO_CLOSE = 'auto_close',
  FUNDING_FLIP = 'funding_flip',
  POSITION_MOVEMENT = 'position_movement',
  SIZE_DRIFT = 'size_drift',
  CLOSE_ERROR = 'close_error',
  BETTER_OPPORTUNITY = 'better_opportunity',
  CUSTOM = 'custom',
}

export interface NotifyPayload {
  privyUserId: string
  type: NotificationType | string
  data: Record<string, unknown>
}

export interface BroadcastPayload {
  message: string
  type?: string
  parseMode?: 'MarkdownV2' | 'HTML'
}

export interface LiquidationWarningData {
  symbol: string
  side: string
  distancePercent: string
  currentPrice: number
  liquidationPrice: number
  protocol: string
}

export interface AutoCloseData {
  symbol: string
  closeReason: string
  closeDetails: string
  longProtocol: string
  shortProtocol: string
  totalMarginUsd: number
}

export interface FundingFlipData {
  symbol: string
  longProtocol: string
  shortProtocol: string
  details: string
}

export interface SizeDriftData {
  symbol: string
  details: string
  longProtocol: string
  shortProtocol: string
}

export interface CloseErrorData {
  symbol: string
  error: string
  retryCount: number
  maxRetries: number
}

export interface BetterOpportunityData {
  currentSymbol: string
  currentApy: number
  betterSymbol: string
  betterApy: number
  betterLongProtocol: string
  betterShortProtocol: string
}
