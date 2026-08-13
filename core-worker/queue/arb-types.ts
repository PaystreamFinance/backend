import { arbPositionPairs } from '@paystream/db/schema'

export interface ArbPositionCheckJobData {
  pairId: number
  /** Back-compat shared ticker (used for display / funding-history grouping).
   *  For cross-ticker pairs this equals `longSymbol`. */
  symbol: string
  /** Per-leg tickers — may differ for cross-ticker pairs. For legacy pairs
   *  these fall back to `symbol`. */
  longSymbol: string
  shortSymbol: string
  longProtocol: string
  shortProtocol: string
  longLiquidationPrice: number | null
  shortLiquidationPrice: number | null
  longMarginUsd: number
  shortMarginUsd: number
  longLeverage: number
  shortLeverage: number
  longNotionalUsd: number
  shortNotionalUsd: number
  sizeAsset: number | null
  privyUserId: string
  userPubkey: string
  ethAddress: string | null
  createdAt: string
  /** 'open' for normal checks, 'closing' for retry verification */
  status: 'open' | 'closing'
  disableAclp: boolean
  survivingLegSlSet: boolean
  disableAutoclose: boolean
}

type ArbPairRow = typeof arbPositionPairs.$inferSelect

/** Human-readable label for a pair's tickers — "BTC" when both legs share a
 *  ticker, "XAU/GOLD" for cross-ticker pairs. */
export function pairLabel(jobData: Pick<ArbPositionCheckJobData, 'longSymbol' | 'shortSymbol'>): string {
  return jobData.longSymbol === jobData.shortSymbol ? jobData.longSymbol : `${jobData.longSymbol}/${jobData.shortSymbol}`
}

/** Backfill per-leg tickers on jobs enqueued before the v2 deploy (those rows
 *  only carry `symbol`). Safe to call on already-normalized data. */
export function normalizeArbJobData(jobData: ArbPositionCheckJobData): ArbPositionCheckJobData {
  if (jobData.longSymbol && jobData.shortSymbol) return jobData
  return {
    ...jobData,
    longSymbol: jobData.longSymbol ?? jobData.symbol,
    shortSymbol: jobData.shortSymbol ?? jobData.symbol,
  }
}

export function pairToJobData(pair: ArbPairRow, status: 'open' | 'closing' = 'open'): ArbPositionCheckJobData {
  return {
    pairId: Number(pair.id),
    symbol: pair.symbol,
    longSymbol: pair.longSymbol ?? pair.symbol,
    shortSymbol: pair.shortSymbol ?? pair.symbol,
    longProtocol: pair.longProtocol,
    shortProtocol: pair.shortProtocol,
    longLiquidationPrice: pair.longLiquidationPrice,
    shortLiquidationPrice: pair.shortLiquidationPrice,
    longMarginUsd: pair.longMarginUsd,
    shortMarginUsd: pair.shortMarginUsd,
    longLeverage: pair.longLeverage,
    shortLeverage: pair.shortLeverage,
    longNotionalUsd: pair.longNotionalUsd,
    shortNotionalUsd: pair.shortNotionalUsd,
    sizeAsset: pair.sizeAsset,
    privyUserId: pair.privyUserId,
    userPubkey: pair.userPubkey,
    ethAddress: pair.ethAddress,
    createdAt: pair.createdAt.toISOString(),
    status,
    disableAclp: pair.disableAclp,
    survivingLegSlSet: pair.survivingLegSlSet,
    disableAutoclose: pair.disableAutoclose,
  }
}
