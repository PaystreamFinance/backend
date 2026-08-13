import { NotificationType } from '../types/notifications.js'
import type {
  AutoCloseData,
  BetterOpportunityData,
  CloseErrorData,
  FundingFlipData,
  LiquidationWarningData,
  SizeDriftData,
} from '../types/notifications.js'

/** Escape special chars for MarkdownV2 */
function esc(text: string | number): string {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function formatNotification(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case NotificationType.LIQUIDATION_WARNING:
      return formatLiquidationWarning(data as unknown as LiquidationWarningData)
    case NotificationType.AUTO_CLOSE:
      return formatAutoClose(data as unknown as AutoCloseData)
    case NotificationType.FUNDING_FLIP:
      return formatFundingFlip(data as unknown as FundingFlipData)
    case NotificationType.SIZE_DRIFT:
      return formatSizeDrift(data as unknown as SizeDriftData)
    case NotificationType.CLOSE_ERROR:
      return formatCloseError(data as unknown as CloseErrorData)
    case NotificationType.BETTER_OPPORTUNITY:
      return formatBetterOpportunity(data as unknown as BetterOpportunityData)
    case NotificationType.CUSTOM:
      return String(data.message ?? 'Notification from Paystream')
    default:
      return `*Paystream Notification*\n\nType: ${esc(type)}\n${esc(JSON.stringify(data, null, 2))}`
  }
}

function formatLiquidationWarning(data: LiquidationWarningData): string {
  return [
    `\u26a0\ufe0f *LIQUIDATION WARNING*`,
    ``,
    `*${esc(data.symbol)}* \\| ${esc(data.side)}`,
    `Protocol: ${esc(capitalize(data.protocol))}`,
    `Distance: *${esc(data.distancePercent)}%* from liquidation`,
    `Current: \\$${esc(Number(data.currentPrice).toFixed(2))}`,
    `Liq Price: \\$${esc(Number(data.liquidationPrice).toFixed(2))}`,
  ].join('\n')
}

function formatAutoClose(data: AutoCloseData): string {
  const reasonLabels: Record<string, string> = {
    liquidation_proximity: 'Liquidation Proximity',
    funding_flip: 'Funding Rate Flip',
    delta_drift: 'Delta Drift',
    pnl_threshold: 'PnL Threshold',
    max_hold_time: 'Max Hold Time',
    error: 'Error',
    unknown: 'Unknown',
  }
  const reason = reasonLabels[data.closeReason] ?? data.closeReason

  const lines = [
    `\ud83d\udd34 *POSITION AUTO\\-CLOSED*`,
    ``,
    `*${esc(data.symbol)}*`,
    `Reason: *${esc(reason)}*`,
    `Details: ${esc(data.closeDetails)}`,
    `Long: ${esc(capitalize(data.longProtocol))} \\| Short: ${esc(capitalize(data.shortProtocol))}`,
  ]
  const margin = Number(data.totalMarginUsd)
  if (!isNaN(margin)) {
    lines.push(`Margin: \\$${esc(margin.toFixed(2))}`)
  }
  return lines.join('\n')
}

function formatFundingFlip(data: FundingFlipData): string {
  return [
    `\ud83d\udd04 *FUNDING RATE FLIP*`,
    ``,
    `*${esc(data.symbol)}*`,
    `Long: ${esc(capitalize(data.longProtocol))} \\| Short: ${esc(capitalize(data.shortProtocol))}`,
    `${esc(data.details)}`,
  ].join('\n')
}

function formatSizeDrift(data: SizeDriftData): string {
  return [
    `\u26a0\ufe0f *SIZE DRIFT DETECTED*`,
    ``,
    `*${esc(data.symbol)}*`,
    `Long: ${esc(capitalize(data.longProtocol))} \\| Short: ${esc(capitalize(data.shortProtocol))}`,
    `${esc(data.details)}`,
  ].join('\n')
}

function formatCloseError(data: CloseErrorData): string {
  return [
    `\u274c *CLOSE ERROR*`,
    ``,
    `*${esc(data.symbol)}*`,
    `Error: ${esc(data.error)}`,
    `Retries: ${esc(data.retryCount)}/${esc(data.maxRetries)}`,
    ``,
    `_Position may require manual intervention\\._`,
  ].join('\n')
}

function formatBetterOpportunity(data: BetterOpportunityData): string {
  return [
    `\ud83d\udca1 *BETTER OPPORTUNITY*`,
    ``,
    `*${esc(data.betterSymbol)}* at *${esc(data.betterApy.toFixed(1))}% APY*`,
    `Long ${esc(capitalize(data.betterLongProtocol))} \\| Short ${esc(capitalize(data.betterShortProtocol))}`,
    ``,
    `Your *${esc(data.currentSymbol)}*: ${esc(data.currentApy.toFixed(1))}% APY`,
  ].join('\n')
}
