import { Worker } from 'bullmq'
import { redisConnectionOptions } from './config'
import { ARB_QUEUE_NAME } from './arb-config'
import { pairLabel, normalizeArbJobData, type ArbPositionCheckJobData } from './arb-types'
import { fetchCurrentPrice } from '@paystream/perps/market-data'
import { fetchLivePosition, type LivePerpPosition } from '../services/arb-position-fetcher'
import { checkFundingRateClose } from '../services/arb-funding-check'
import { triggerClose } from '../services/arb-close'
import { triggerSetStopLoss } from '../services/arb-set-sl'
import { oiMonitor } from '../services/oi-monitor'
import {
  type RiskParams,
  computeLiqProximityTag,
  computeFundingTag,
  computeOiCascadeTag,
  worstTag,
  shouldCloseFromTags,
} from '../services/arb-risk-tags'
import { db } from '@paystream/db'
import { arbPositionPairs, arbCloseReasonEnum } from '@paystream/db/schema'
import { eq } from 'drizzle-orm'
import { log } from '../utils/log'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'
import { notifyTelegram } from '../utils/telegram-notify'

/** Liquidation proximity threshold — close when price is within 5% of liq price */
const PROXIMITY_THRESHOLD = 0.05

/** Size drift — close when asset size changed by more than 5% */
const SIZE_DRIFT_THRESHOLD = 0.05

/** Grace period after pair creation before delta drift can trigger (on-chain settlement) */
const SETTLEMENT_GRACE_MS = 60_000

/** Max retries for stuck closes */
const MAX_CLOSE_RETRIES = 5

/** SL distance from current price for the surviving leg under disableAclp (0.05%). */
const SURVIVING_LEG_SL_OFFSET = 0.0005

/**
 * Tolerance for confirming a one-leg-gone event was a real liquidation: the
 * current price must be at or past the gone leg's stored liq price within
 * this fraction. Wider than zero so a brief recovery wick after liquidation
 * still confirms; tight enough that manual closes / API glitches don't pass.
 */
const LIQ_CONFIRM_TOLERANCE = 0.005

type ArbCloseReason = (typeof arbCloseReasonEnum.enumValues)[number]

// Current margin = initial deposit + unrealized PnL. Using the venue-reported
// marginUsd directly is unsafe: Pacifica reports the static initial deposit
// (no PnL) and 01's is an imf approximation — either makes a hedged pair's
// drawdown ignore the winning leg's profit and look one-sided.
function effectiveMarginUsd(
  initialMarginUsd: number,
  pos: LivePerpPosition,
): number {
  return initialMarginUsd + pos.unrealizedPnl
}

/** Map risk tag param name to arbCloseReason enum value */
const TAG_REASON_TO_CLOSE_REASON: Record<string, ArbCloseReason> = {
  liqProximity: 'liquidation_proximity',
  funding: 'funding_flip',
  oiCascade: 'oi_cascade',
  equityDrawdown: 'equity_drawdown',
  risk_threshold: 'risk_threshold',
}

async function processArbCheck(
  jobData: ArbPositionCheckJobData,
): Promise<{ checked: boolean; closeTriggered: boolean }> {
  const { pairId, longSymbol, shortSymbol } = jobData
  const label = pairLabel(jobData)

  // Re-check DB status — job data may be stale from a previous producer cycle
  const [freshPair] = await db.select({
    active: arbPositionPairs.active,
    status: arbPositionPairs.status,
    riskParams: arbPositionPairs.riskParams,
    disableAclp: arbPositionPairs.disableAclp,
    survivingLegSlSet: arbPositionPairs.survivingLegSlSet,
    disableAutoclose: arbPositionPairs.disableAutoclose,
  })
    .from(arbPositionPairs)
    .where(eq(arbPositionPairs.id, pairId))
    .limit(1)
  if (!freshPair || !freshPair.active || (freshPair.status !== 'open' && freshPair.status !== 'closing')) {
    return { checked: false, closeTriggered: false }
  }

  if (jobData.status === 'closing' || freshPair.status === 'closing') {
    return processRetryCheck(jobData)
  }

  // disableAutoclose: full opt-out of monitoring — producer normally filters
  // these out, but guard here too in case a stale job is in flight.
  if (freshPair.disableAutoclose) {
    return { checked: false, closeTriggered: false }
  }

  // Read flags from freshPair, not jobData — the row may have changed since
  // the producer enqueued (e.g. SL just got set on the previous tick).
  const { disableAclp, survivingLegSlSet } = freshPair

  if (survivingLegSlSet) {
    return processPostSlCheck(jobData)
  }

  const {
    longProtocol, shortProtocol,
    longLiquidationPrice, shortLiquidationPrice,
  } = jobData

  // 1. Fetch current price — use each leg's own ticker on its own dex.
  //    For cross-ticker pairs both legs track the same underlying asset; we
  //    still prefer the long leg's quote but fall back to the short leg's.
  const currentPrice = await fetchCurrentPrice(longSymbol, longProtocol)
    || await fetchCurrentPrice(shortSymbol, shortProtocol)

  if (!currentPrice) {
    log.warn(`[arb-worker] pair=${pairId} ${label}: Could not fetch price, skipping`)
    return { checked: false, closeTriggered: false }
  }

  // 2. Fetch live positions (used for delta drift + margin tracking)
  let longPos: LivePerpPosition | null = null
  let shortPos: LivePerpPosition | null = null
  let positionsFetched = false

  const pairAge = Date.now() - new Date(jobData.createdAt).getTime()
  if (pairAge >= SETTLEMENT_GRACE_MS) {
    const [longResult, shortResult] = await Promise.all([
      fetchLivePosition(longProtocol, longSymbol, jobData.ethAddress, jobData.userPubkey, jobData.privyUserId),
      fetchLivePosition(shortProtocol, shortSymbol, jobData.ethAddress, jobData.userPubkey, jobData.privyUserId),
    ])

    if (longResult.ok && shortResult.ok) {
      longPos = longResult.position
      shortPos = shortResult.position
      positionsFetched = true
    } else {
      const errors: string[] = []
      if (!longResult.ok) errors.push(`long: ${longResult.error}`)
      if (!shortResult.ok) errors.push(`short: ${shortResult.error}`)
      log.warn(`[arb-worker] pair=${pairId} ${label}: Position fetch errors: ${errors.join(', ')}`)
    }
  }

  // 3. Compute liquidation proximity + tag
  let longDist: number | null = null
  let shortDist: number | null = null

  if (longLiquidationPrice && longLiquidationPrice > 0) {
    longDist = Math.abs(currentPrice - longLiquidationPrice) / currentPrice
  }
  if (shortLiquidationPrice && shortLiquidationPrice > 0) {
    shortDist = Math.abs(currentPrice - shortLiquidationPrice) / currentPrice
  }

  const minDist = Math.min(longDist ?? Infinity, shortDist ?? Infinity)
  const liqProximityTag = minDist < Infinity ? computeLiqProximityTag(minDist) : 'normal'

  // 4. Delta drift — immediate close path (not tag-based)
  let deltaDriftClose = false
  let deltaDriftReason: ArbCloseReason = 'delta_drift'
  let deltaDriftDetails = ''
  let oneLegLiquidatedSurvivor: 'long' | 'short' | null = null

  if (positionsFetched) {
    const driftResult = checkDeltaDrift(jobData, longPos, shortPos, disableAclp, currentPrice)
    if (driftResult.shouldClose) {
      deltaDriftClose = true
      deltaDriftReason = driftResult.reason === 'position_gone' ? 'unknown' : 'delta_drift'
      deltaDriftDetails = driftResult.details
    } else if (driftResult.oneLegLiquidated) {
      oneLegLiquidatedSurvivor = driftResult.oneLegLiquidated
      deltaDriftDetails = driftResult.details
    }
  }

  // 5. Funding rate check (always on — kept active even under disableAclp).
  //    Each leg's funding series is stored under its own per-dex ticker.
  const fundingResult = await checkFundingRateClose(
    longSymbol, shortSymbol, longProtocol, shortProtocol, new Date(jobData.createdAt),
  )
  const fundingTag = computeFundingTag(fundingResult.negCount)

  // 6. OI cascade — query monitor per-leg with its own ticker, take worst
  const longOiChange = oiMonitor.getOiChangePerHour(longSymbol, longProtocol)
  const shortOiChange = oiMonitor.getOiChangePerHour(shortSymbol, shortProtocol)
  const worstOiChange = Math.min(longOiChange ?? 0, shortOiChange ?? 0)
  const oiCascadeTag = computeOiCascadeTag(worstOiChange)

  // 7. Equity drawdown — read from DB (producer writes this)
  const existingParams = (freshPair.riskParams ?? {}) as Partial<RiskParams>
  const equityDrawdownTag = existingParams.equityDrawdown ?? 'normal'

  // disableAclp suppresses every tag except funding so the pair can ride to
  // a real liquidation; funding remains the only active protection.
  const riskParams: RiskParams = {
    liqProximity: disableAclp ? 'normal' : liqProximityTag,
    funding: fundingTag,
    oiCascade: disableAclp ? 'normal' : oiCascadeTag,
    equityDrawdown: disableAclp ? 'normal' : equityDrawdownTag,
  }

  const aggregateTag = worstTag(riskParams)

  // 9. Determine close action
  let shouldClose = false
  let closeReason: ArbCloseReason = 'unknown'
  let closeDetails = ''

  // Delta drift always takes priority (immediate close)
  if (deltaDriftClose) {
    shouldClose = true
    closeReason = deltaDriftReason
    closeDetails = deltaDriftDetails
  } else {
    // Tag-based close decision
    const tagDecision = shouldCloseFromTags(riskParams)
    if (tagDecision.shouldClose) {
      shouldClose = true
      closeReason = TAG_REASON_TO_CLOSE_REASON[tagDecision.reason] ?? 'unknown'
      closeDetails = `Risk tags: ${JSON.stringify(riskParams)}`
    }
  }

  // Summary log
  const longDistPct = longDist !== null ? (longDist * 100).toFixed(2) : 'n/a'
  const shortDistPct = shortDist !== null ? (shortDist * 100).toFixed(2) : 'n/a'
  const survivorTag = oneLegLiquidatedSurvivor ? ` | LIQUIDATED:${oneLegLiquidatedSurvivor === 'long' ? 'short' : 'long'}` : ''
  log.info(
    `[arb-worker] pair=${pairId} ${label} | $${currentPrice.toFixed(2)}` +
    ` | liq: L=${longDistPct}% S=${shortDistPct}%` +
    ` | tag=${aggregateTag}${disableAclp ? ' [ACLP off]' : ''}${survivorTag}` +
    ` | ${shouldClose ? `CLOSE (${closeReason}): ${closeDetails}` : 'OK'}`,
  )

  // 10. Persist risk data + last checked
  try {
    await db.update(arbPositionPairs)
      .set({
        lastOraclePrice: currentPrice,
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
        riskTag: aggregateTag,
        riskParams,
        negFundingCount: fundingResult.negCount,
        currentLongMarginUsd: longPos ? effectiveMarginUsd(jobData.longMarginUsd, longPos) : null,
        currentShortMarginUsd: shortPos ? effectiveMarginUsd(jobData.shortMarginUsd, shortPos) : null,
      })
      .where(eq(arbPositionPairs.id, pairId))
  } catch (e) {
    log.error(`[arb-worker] pair=${pairId}: Failed to update risk data:`, e)
  }

  // oneLegLiquidatedSurvivor is only set when disableAclp=true and exactly one
  // leg is gone — set the tight SL and skip the normal close path.
  if (oneLegLiquidatedSurvivor) {
    const survivingLeg = oneLegLiquidatedSurvivor
    const survivingProtocol = survivingLeg === 'long' ? jobData.longProtocol : jobData.shortProtocol
    const survivingMarket = survivingLeg === 'long' ? longSymbol : shortSymbol
    const slPrice = currentPrice * (survivingLeg === 'long'
      ? (1 - SURVIVING_LEG_SL_OFFSET)
      : (1 + SURVIVING_LEG_SL_OFFSET))

    log.warn(
      `[arb-worker] pair=${pairId} ${label}: one-leg liquidated, ` +
      `placing SL on surviving ${survivingLeg} (${survivingProtocol}:${survivingMarket}) @ $${slPrice.toFixed(6)} ` +
      `(currentPrice=$${currentPrice.toFixed(6)})`,
    )

    const slResult = await triggerSetStopLoss(jobData, survivingProtocol, survivingMarket, slPrice)
    if (slResult.ok) {
      try {
        await db.update(arbPositionPairs)
          .set({ survivingLegSlSet: true, updatedAt: new Date() })
          .where(eq(arbPositionPairs.id, pairId))
      } catch (e) {
        log.error(`[arb-worker] pair=${pairId}: Failed to mark surviving_leg_sl_set:`, e)
      }

      notifyTelegram(jobData.privyUserId, 'auto_close', {
        symbol: label,
        closeReason: 'liquidation_partial',
        closeDetails: `One leg liquidated — SL set on surviving ${survivingLeg} (${survivingProtocol}:${survivingMarket}) @ $${slPrice.toFixed(6)}`,
        longProtocol: jobData.longProtocol,
        shortProtocol: jobData.shortProtocol,
        totalMarginUsd: jobData.longMarginUsd + jobData.shortMarginUsd,
      })
    } else {
      // Leave survivingLegSlSet false so the next worker tick retries.
      // triggerSetStopLoss already raised an ops alert.
      log.error(`[arb-worker] pair=${pairId}: SL placement failed, will retry: ${slResult.error}`)
    }

    return { checked: true, closeTriggered: false }
  }

  if (shouldClose) {
    notifyTelegram(jobData.privyUserId, 'auto_close', {
      symbol: label,
      closeReason,
      closeDetails,
      longProtocol: jobData.longProtocol,
      shortProtocol: jobData.shortProtocol,
      totalMarginUsd: jobData.longMarginUsd + jobData.shortMarginUsd,
    })

    await triggerClose(jobData, closeReason, closeDetails)
  }

  return { checked: true, closeTriggered: shouldClose }
}

// ---------------------------------------------------------------------------
// Delta drift / ADL protection (uses pre-fetched positions)
// ---------------------------------------------------------------------------

interface DeltaDriftResult {
  shouldClose: boolean
  details: string
  reason?: 'position_gone' | 'size_drift' | 'size_imbalance'
  /** Surviving leg when disableAclp is on and exactly one leg is gone. */
  oneLegLiquidated?: 'long' | 'short'
}

function checkDeltaDrift(
  jobData: ArbPositionCheckJobData,
  longPos: LivePerpPosition | null,
  shortPos: LivePerpPosition | null,
  disableAclp: boolean,
  currentPrice: number,
): DeltaDriftResult {
  const { longProtocol, shortProtocol, sizeAsset, longLiquidationPrice, shortLiquidationPrice } = jobData
  const storedSize = sizeAsset ?? 0

  // Position gone → external close / liquidation
  if (!longPos && !shortPos) {
    return { shouldClose: true, reason: 'position_gone', details: 'Both positions gone — closed externally' }
  }

  // Exactly one leg gone. Under disableAclp this MIGHT be the SL-trigger signal,
  // but only if the gone leg's price has actually reached its liquidation price —
  // otherwise it's a manual close / API glitch and we close the pair like normal.
  if (!longPos || !shortPos) {
    const goneLeg: 'long' | 'short' = !longPos ? 'long' : 'short'
    const survivingLeg: 'long' | 'short' = goneLeg === 'long' ? 'short' : 'long'
    const goneProtocol = goneLeg === 'long' ? longProtocol : shortProtocol
    const survivingProtocol = goneLeg === 'long' ? shortProtocol : longProtocol
    const goneLabel = goneLeg === 'long' ? 'Long' : 'Short'

    if (disableAclp) {
      const goneLiqPrice = goneLeg === 'long' ? longLiquidationPrice : shortLiquidationPrice
      const priceConfirmsLiq = (goneLiqPrice ?? 0) > 0 && (
        goneLeg === 'long'
          ? currentPrice <= goneLiqPrice! * (1 + LIQ_CONFIRM_TOLERANCE)
          : currentPrice >= goneLiqPrice! * (1 - LIQ_CONFIRM_TOLERANCE)
      )

      if (priceConfirmsLiq) {
        return {
          shouldClose: false,
          oneLegLiquidated: survivingLeg,
          details: `${goneLabel} (${goneProtocol}) liquidated (price=$${currentPrice.toFixed(6)} vs liq=$${goneLiqPrice!.toFixed(6)}) — surviving ${survivingLeg} (${survivingProtocol}) will get SL`,
        }
      }
      return {
        shouldClose: true,
        reason: 'position_gone',
        details: `${goneLabel} (${goneProtocol}) gone but price=$${currentPrice.toFixed(6)} not at liq=$${goneLiqPrice ?? 'n/a'} — treating as external close`,
      }
    }
    return {
      shouldClose: true,
      reason: 'position_gone',
      details: `${goneLabel} (${goneProtocol}) gone — closed externally`,
    }
  }

  // Size drift / imbalance still apply even under disableAclp: while both legs
  // are open we want to stay delta neutral, so a partial ADL or fill skew must
  // still close the pair. The liq-proximity / oi / equity tag suppression in
  // processArbCheck is what lets the pair ride to a real liquidation.
  if (storedSize > 0) {
    const longDrift = Math.abs(longPos.sizeAsset - storedSize) / storedSize
    const shortDrift = Math.abs(shortPos.sizeAsset - storedSize) / storedSize

    if (longDrift > SIZE_DRIFT_THRESHOLD) {
      return {
        shouldClose: true, reason: 'size_drift',
        details: `Long size ${(longDrift * 100).toFixed(1)}% drift: stored=${storedSize} live=${longPos.sizeAsset}`,
      }
    }
    if (shortDrift > SIZE_DRIFT_THRESHOLD) {
      return {
        shouldClose: true, reason: 'size_drift',
        details: `Short size ${(shortDrift * 100).toFixed(1)}% drift: stored=${storedSize} live=${shortPos.sizeAsset}`,
      }
    }
  }

  // Cross-leg imbalance
  const avgSize = (longPos.sizeAsset + shortPos.sizeAsset) / 2
  if (avgSize > 0) {
    const imbalance = Math.abs(longPos.sizeAsset - shortPos.sizeAsset) / avgSize
    if (imbalance > SIZE_DRIFT_THRESHOLD) {
      return {
        shouldClose: true, reason: 'size_imbalance',
        details: `Size imbalance ${(imbalance * 100).toFixed(1)}%: long=${longPos.sizeAsset} short=${shortPos.sizeAsset}`,
      }
    }
  }

  return { shouldClose: false, details: `OK (L=${longPos.sizeAsset} S=${shortPos.sizeAsset})` }
}

/**
 * Once the surviving-leg SL is in place, all risk checks are off. We only
 * watch for both legs to be gone (SL fired) and mark the pair closed.
 */
async function processPostSlCheck(
  jobData: ArbPositionCheckJobData,
): Promise<{ checked: boolean; closeTriggered: boolean }> {
  const { pairId, longSymbol, shortSymbol, longProtocol, shortProtocol, ethAddress, userPubkey, privyUserId } = jobData
  const label = pairLabel(jobData)

  const [longResult, shortResult] = await Promise.all([
    fetchLivePosition(longProtocol, longSymbol, ethAddress, userPubkey, privyUserId),
    fetchLivePosition(shortProtocol, shortSymbol, ethAddress, userPubkey, privyUserId),
  ])

  if (!longResult.ok || !shortResult.ok) {
    log.warn(`[arb-worker] pair=${pairId} ${label}: post-SL fetch errors, skipping`)
    return { checked: false, closeTriggered: false }
  }

  const longPos = longResult.position
  const shortPos = shortResult.position

  if (!longPos && !shortPos) {
    log.info(`[arb-worker] pair=${pairId} ${label}: surviving-leg SL fired — both positions gone, marking closed`)
    try {
      await db.update(arbPositionPairs)
        .set({
          status: 'closed',
          active: false,
          closeReason: 'liquidation_partial',
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(arbPositionPairs.id, pairId))
    } catch (e) {
      log.error(`[arb-worker] pair=${pairId}: Failed to mark post-SL closed:`, e)
    }
    return { checked: true, closeTriggered: false }
  }

  try {
    await db.update(arbPositionPairs)
      .set({ lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(arbPositionPairs.id, pairId))
  } catch (e) {
    log.error(`[arb-worker] pair=${pairId}: Failed to update post-SL lastCheckedAt:`, e)
  }

  log.info(`[arb-worker] pair=${pairId} ${label}: post-SL waiting (long=${!!longPos} short=${!!shortPos})`)
  return { checked: true, closeTriggered: false }
}

// ---------------------------------------------------------------------------
// Retry mechanism for stuck closes
// ---------------------------------------------------------------------------

async function processRetryCheck(
  jobData: ArbPositionCheckJobData,
): Promise<{ checked: boolean; closeTriggered: boolean }> {
  const { pairId, longSymbol, shortSymbol, longProtocol, shortProtocol, ethAddress, userPubkey, privyUserId } = jobData
  const label = pairLabel(jobData)

  const [pair] = await db.select({
    closeRetryCount: arbPositionPairs.closeRetryCount,
    status: arbPositionPairs.status,
    closeReason: arbPositionPairs.closeReason,
  })
    .from(arbPositionPairs)
    .where(eq(arbPositionPairs.id, pairId))
    .limit(1)

  if (!pair || pair.status !== 'closing') {
    return { checked: true, closeTriggered: false }
  }

  const retryCount = pair.closeRetryCount

  if (retryCount >= MAX_CLOSE_RETRIES) {
    log.error(`[arb-worker] pair=${pairId} ${label}: Max retries (${MAX_CLOSE_RETRIES}) exceeded`)
    sendOpsAlert({
      key: `arb-close-max-retries-${pairId}`,
      severity: AlertSeverity.WARNING,
      title: 'Arb close max retries exceeded',
      message: `pair=${pairId} ${label}: ${MAX_CLOSE_RETRIES} retries exhausted. Manual intervention needed.`,
      service: 'core-worker',
    })
    await db.update(arbPositionPairs)
      .set({
        status: 'error',
        closeError: `Max close retries (${MAX_CLOSE_RETRIES}) exceeded`,
        updatedAt: new Date(),
      })
      .where(eq(arbPositionPairs.id, pairId))

    notifyTelegram(privyUserId, 'close_error', {
      symbol: label,
      error: `Max close retries (${MAX_CLOSE_RETRIES}) exceeded`,
      retryCount,
      maxRetries: MAX_CLOSE_RETRIES,
    })

    return { checked: true, closeTriggered: false }
  }

  const [longResult, shortResult] = await Promise.all([
    fetchLivePosition(longProtocol, longSymbol, ethAddress, userPubkey, privyUserId),
    fetchLivePosition(shortProtocol, shortSymbol, ethAddress, userPubkey, privyUserId),
  ])

  if (!longResult.ok || !shortResult.ok) {
    log.warn(`[arb-worker] pair=${pairId} ${label}: Retry check skipped — fetch errors`)
    return { checked: true, closeTriggered: false }
  }

  const longPos = longResult.position
  const shortPos = shortResult.position

  if (!longPos && !shortPos) {
    log.info(`[arb-worker] pair=${pairId} ${label}: Close verified — both positions gone`)
    await db.update(arbPositionPairs)
      .set({
        status: 'closed',
        active: false,
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(arbPositionPairs.id, pairId))
    return { checked: true, closeTriggered: false }
  }

  const stillOpen = [
    longPos ? `long(${longProtocol}:${longSymbol})` : null,
    shortPos ? `short(${shortProtocol}:${shortSymbol})` : null,
  ].filter(Boolean).join(', ')

  log.warn(`[arb-worker] pair=${pairId} ${label}: Close incomplete (retry ${retryCount + 1}/${MAX_CLOSE_RETRIES}), still open: ${stillOpen}`)

  await db.update(arbPositionPairs)
    .set({ closeRetryCount: retryCount + 1, updatedAt: new Date() })
    .where(eq(arbPositionPairs.id, pairId))

  await triggerClose(jobData, pair.closeReason ?? 'error', `Retry #${retryCount + 1}: ${stillOpen} still open`)
  return { checked: true, closeTriggered: true }
}

export function startArbWorker() {
  const worker = new Worker<ArbPositionCheckJobData>(
    ARB_QUEUE_NAME,
    async (job) => processArbCheck(normalizeArbJobData(job.data)),
    { connection: redisConnectionOptions, concurrency: 5 },
  )

  worker.on('failed', (job, err) => {
    log.error(`[arb-worker] Job ${job?.id} failed:`, err.message)
    sendOpsAlert({
      key: 'arb-job-failed',
      severity: AlertSeverity.WARNING,
      title: 'Arb worker job failed',
      message: `Job ${job?.id}: ${err.message}`,
      service: 'core-worker',
    })
  })

  worker.on('error', (err) => {
    log.error('[arb-worker] Worker error:', err)
    sendOpsAlert({
      key: 'arb-worker-error',
      severity: AlertSeverity.WARNING,
      title: 'Arb worker error',
      message: err instanceof Error ? err.message : String(err),
      service: 'core-worker',
      error: err,
    })
  })

  log.info('[arb-worker] Started')
}
