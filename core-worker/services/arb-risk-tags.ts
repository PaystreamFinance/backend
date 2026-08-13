export type { RiskTag, RiskParams } from '@paystream/db/schema'
import type { RiskTag, RiskParams } from '@paystream/db/schema'

const TAG_SEVERITY: Record<RiskTag, number> = {
  normal: 0,
  warn: 1,
  reduce: 2,
  critical: 3,
}

/**
 * Liquidation proximity tag based on distance from liquidation price.
 * @param distance - fractional distance (e.g. 0.15 = 15%)
 */
export function computeLiqProximityTag(distance: number): RiskTag {
  if (distance < 0.05) return 'critical'
  if (distance < 0.10) return 'reduce'
  if (distance < 0.20) return 'warn'
  return 'normal'
}

/**
 * Funding tag based on count of negative net-funding hours out of last 12.
 * @param negCount - number of negative net-funding hours
 */
export function computeFundingTag(negCount: number): RiskTag {
  if (negCount >= 6) return 'critical'
  if (negCount >= 4) return 'warn'
  return 'normal'
}

/**
 * OI cascade tag based on hourly rate of OI change.
 * @param oiChangePerHour - fractional change per hour (e.g. -0.15 = -15%/hr)
 */
export function computeOiCascadeTag(oiChangePerHour: number): RiskTag {
  if (oiChangePerHour < -0.45) return 'critical'
  if (oiChangePerHour < -0.35) return 'reduce'
  if (oiChangePerHour < -0.30) return 'warn'
  return 'normal'
}

/**
 * Equity drawdown tag based on portfolio drawdown ratio.
 * @param drawdown - fractional drawdown (e.g. 0.03 = 3%)
 */
export function computeEquityDrawdownTag(drawdown: number): RiskTag {
  if (drawdown > 0.05) return 'critical'
  if (drawdown > 0.02) return 'reduce'
  if (drawdown > 0.01) return 'warn'
  return 'normal'
}

/** Returns the worst (highest severity) tag across all params. */
export function worstTag(params: RiskParams): RiskTag {
  let worst: RiskTag = 'normal'
  for (const tag of Object.values(params)) {
    if (TAG_SEVERITY[tag as RiskTag] > TAG_SEVERITY[worst]) {
      worst = tag as RiskTag
    }
  }
  return worst
}

/**
 * Close decision based on aggregate risk tags.
 * - Any CRITICAL → close
 * - 3+ REDUCE (or higher) → close
 */
export function shouldCloseFromTags(params: RiskParams): { shouldClose: boolean; reason: string } {
  const tags = Object.entries(params)

  // Any CRITICAL → close with that param as reason
  for (const [param, tag] of tags) {
    if (tag === 'critical') {
      return { shouldClose: true, reason: param }
    }
  }

  // 3+ REDUCE or higher → close
  const reduceOrAbove = tags.filter(([, tag]) => TAG_SEVERITY[tag as RiskTag] >= TAG_SEVERITY.reduce)
  if (reduceOrAbove.length >= 3) {
    return {
      shouldClose: true,
      reason: 'risk_threshold',
    }
  }

  return { shouldClose: false, reason: '' }
}
