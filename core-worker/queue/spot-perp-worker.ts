import { Worker } from 'bullmq'
import { redisConnectionOptions } from './config'
import { SPOT_PERP_QUEUE_NAME } from './spot-perp-config'
import type { SpotPerpCheckJobData } from './spot-perp-types'
import { fetchCurrentPrice } from '@paystream/perps/market-data'
import { fetchLivePosition } from '../services/arb-position-fetcher'
import { connection } from '../clients/solana'
import { db } from '@paystream/db'
import { spotPerpTrades } from '@paystream/db/schema'
import { eq } from 'drizzle-orm'
import { log } from '../utils/log'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:9000'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

/** Liquidation proximity threshold — close when price is within 5% of liq price */
const PROXIMITY_THRESHOLD = 0.05

/** Size drift — close when asset size changed by more than 5% */
const SIZE_DRIFT_THRESHOLD = 0.05

/** Grace period after trade creation before delta drift can trigger (on-chain settlement) */
const SETTLEMENT_GRACE_MS = 60_000

/** Max retries for stuck closes */
const MAX_CLOSE_RETRIES = 5

/** Max immediate retries for spot confirmation within a single close attempt */
const SPOT_CONFIRM_MAX_RETRIES = 3

/** Polling interval for transaction confirmation (ms) */
const SPOT_CONFIRM_POLL_MS = 2_000

/** Max polls per confirmation check (8 × 2s = 16s) */
const SPOT_CONFIRM_MAX_POLLS = 8

async function processSpotPerpCheck(
  jobData: SpotPerpCheckJobData,
): Promise<{ checked: boolean; closeTriggered: boolean }> {
  const { tradeId, market } = jobData

  // Re-check DB status — job data may be stale from a previous producer cycle
  const [freshTrade] = await db.select({ active: spotPerpTrades.active, status: spotPerpTrades.status })
    .from(spotPerpTrades)
    .where(eq(spotPerpTrades.id, tradeId))
    .limit(1)
  if (!freshTrade || !freshTrade.active || (freshTrade.status !== 'open' && freshTrade.status !== 'closing')) {
    return { checked: false, closeTriggered: false }
  }

  if (jobData.status === 'closing' || freshTrade.status === 'closing') {
    return processRetryCheck(jobData)
  }

  // Perp leg never opened — immediately unwind spot
  if (!jobData.perpTxnHash) {
    log.warn(`[spot-perp-worker] trade=${tradeId} ${market}: Perp leg never opened, unwinding spot`)
    await triggerClose(jobData, 'error', 'Perp leg failed at open — unwinding spot')
    return { checked: true, closeTriggered: true }
  }

  const { perpProtocol, perpLiquidationPrice } = jobData

  const currentPrice = await fetchCurrentPrice(market, perpProtocol)

  if (!currentPrice) {
    log.warn(`[spot-perp-worker] trade=${tradeId} ${market}: Could not fetch price, skipping`)
    return { checked: false, closeTriggered: false }
  }

  let shouldClose = false
  let closeReason: string = 'liquidation_proximity'
  let closeDetails = ''
  let liqDistPct: string | null = null

  // 1. Liquidation proximity (perp short only)
  if (perpLiquidationPrice && perpLiquidationPrice > 0) {
    const distance = Math.abs(currentPrice - perpLiquidationPrice) / currentPrice
    liqDistPct = (distance * 100).toFixed(2)
    if (distance < PROXIMITY_THRESHOLD) {
      shouldClose = true
      closeDetails = `SHORT ${liqDistPct}% from liq (price=$${currentPrice.toFixed(2)}, liq=$${perpLiquidationPrice.toFixed(2)})`
    }
  }

  // 2. Delta drift / ADL — only if not already closing for liq
  if (!shouldClose) {
    const deltaDriftResult = await checkDeltaDrift(jobData, currentPrice)
    if (deltaDriftResult.shouldClose) {
      shouldClose = true
      closeReason = deltaDriftResult.reason === 'position_gone' ? 'unknown' : 'delta_drift'
      closeDetails = deltaDriftResult.details
    }
  }

  // Summary log
  log.info(
    `[spot-perp-worker] trade=${tradeId} ${market} | $${currentPrice.toFixed(2)}` +
    ` | liq: ${liqDistPct ?? 'n/a'}%` +
    ` | ${shouldClose ? `CLOSE (${closeReason}): ${closeDetails}` : 'OK'}`,
  )

  // Update last checked
  try {
    await db.update(spotPerpTrades)
      .set({
        lastOraclePrice: currentPrice,
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(spotPerpTrades.id, tradeId))
  } catch (e) {
    log.error(`[spot-perp-worker] trade=${tradeId}: Failed to update last_checked:`, e)
  }

  if (shouldClose) {
    await triggerClose(jobData, closeReason, closeDetails)
  }

  return { checked: true, closeTriggered: shouldClose }
}

// ---------------------------------------------------------------------------
// Delta drift / ADL protection
// ---------------------------------------------------------------------------

async function checkDeltaDrift(
  jobData: SpotPerpCheckJobData,
  _currentPrice: number,
): Promise<{ shouldClose: boolean; details: string; reason?: 'position_gone' | 'size_drift' }> {
  const {
    tradeId, market, perpProtocol,
    ethAddress, userPubkey, sizeAsset,
  } = jobData

  const storedSize = sizeAsset ?? 0

  // Grace period: on-chain orders may not have settled yet
  const tradeAge = Date.now() - new Date(jobData.createdAt).getTime()
  if (tradeAge < SETTLEMENT_GRACE_MS) {
    return { shouldClose: false, details: 'Settlement grace period' }
  }

  const result = await fetchLivePosition(perpProtocol, market, ethAddress, userPubkey)

  // API failure → skip, don't false-positive
  if (!result.ok) {
    log.warn(`[spot-perp-worker] trade=${tradeId} ${market}: Skipping delta drift — fetch error: ${result.error}`)
    return { shouldClose: false, details: `Skipped (fetch error)` }
  }

  const perpPos = result.position

  // Position gone → external close / liquidation / ADL
  if (!perpPos) {
    return { shouldClose: true, reason: 'position_gone', details: `Perp short (${perpProtocol}) gone — closed externally or liquidated` }
  }

  // Size drift vs stored size (ADL, partial close)
  if (storedSize > 0) {
    const sizeDrift = Math.abs(perpPos.sizeAsset - storedSize) / storedSize

    if (sizeDrift > SIZE_DRIFT_THRESHOLD) {
      return {
        shouldClose: true, reason: 'size_drift',
        details: `Perp size ${(sizeDrift * 100).toFixed(1)}% drift: stored=${storedSize} live=${perpPos.sizeAsset}`,
      }
    }
  }

  return { shouldClose: false, details: `OK (perp size=${perpPos.sizeAsset})` }
}

// ---------------------------------------------------------------------------
// Retry mechanism for stuck closes
// ---------------------------------------------------------------------------

async function processRetryCheck(
  jobData: SpotPerpCheckJobData,
): Promise<{ checked: boolean; closeTriggered: boolean }> {
  const { tradeId, market, perpProtocol, ethAddress, userPubkey } = jobData

  const [trade] = await db.select({
    closeRetryCount: spotPerpTrades.closeRetryCount,
    status: spotPerpTrades.status,
    closeReason: spotPerpTrades.closeReason,
    closeSpotTxnHash: spotPerpTrades.closeSpotTxnHash,
    closePerpTxnHash: spotPerpTrades.closePerpTxnHash,
  })
    .from(spotPerpTrades)
    .where(eq(spotPerpTrades.id, tradeId))
    .limit(1)

  if (!trade || trade.status !== 'closing') {
    return { checked: true, closeTriggered: false }
  }

  const retryCount = trade.closeRetryCount

  if (retryCount >= MAX_CLOSE_RETRIES) {
    log.error(`[spot-perp-worker] trade=${tradeId} ${market}: Max retries (${MAX_CLOSE_RETRIES}) exceeded`)
    sendOpsAlert({
      key: `spot-perp-close-max-retries-${tradeId}`,
      severity: AlertSeverity.WARNING,
      title: 'Spot-perp close max retries exceeded',
      message: `trade=${tradeId} ${market}: ${MAX_CLOSE_RETRIES} retries exhausted. Manual intervention needed.`,
      service: 'core-worker',
    })
    await db.update(spotPerpTrades)
      .set({
        status: 'error',
        closeError: `Max close retries (${MAX_CLOSE_RETRIES}) exceeded`,
        updatedAt: new Date(),
      })
      .where(eq(spotPerpTrades.id, tradeId))
    return { checked: true, closeTriggered: false }
  }

  // Perp was never opened — just retry spot sell, can't verify via position check
  if (!jobData.perpTxnHash) {
    log.warn(`[spot-perp-worker] trade=${tradeId} ${market}: Retrying spot unwind (retry ${retryCount + 1}/${MAX_CLOSE_RETRIES}), perp was never opened`)
    await db.update(spotPerpTrades)
      .set({ closeRetryCount: retryCount + 1, updatedAt: new Date() })
      .where(eq(spotPerpTrades.id, tradeId))
    await triggerClose(jobData, trade.closeReason ?? 'error', `Retry #${retryCount + 1}: spot unwind (perp never opened)`)
    return { checked: true, closeTriggered: true }
  }

  const result = await fetchLivePosition(perpProtocol, market, ethAddress, userPubkey)

  if (!result.ok) {
    log.warn(`[spot-perp-worker] trade=${tradeId} ${market}: Retry check skipped — fetch error`)
    return { checked: true, closeTriggered: false }
  }

  const perpPos = result.position

  // Perp position gone — check if spot was also sold
  if (!perpPos) {
    if (trade.closeSpotTxnHash) {
      // Both legs done
      log.info(`[spot-perp-worker] trade=${tradeId} ${market}: Close verified — both legs done`)
      await db.update(spotPerpTrades)
        .set({
          status: 'closed',
          active: false,
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(spotPerpTrades.id, tradeId))
      return { checked: true, closeTriggered: false }
    }

    // Perp closed but spot still pending — retrigger to sell spot
    log.warn(`[spot-perp-worker] trade=${tradeId} ${market}: Perp gone but spot unsold, retrying spot sell (retry ${retryCount + 1}/${MAX_CLOSE_RETRIES})`)
    await db.update(spotPerpTrades)
      .set({ closeRetryCount: retryCount + 1, updatedAt: new Date() })
      .where(eq(spotPerpTrades.id, tradeId))
    await triggerClose(jobData, trade.closeReason ?? 'error', `Retry #${retryCount + 1}: perp gone, spot unsold`)
    return { checked: true, closeTriggered: true }
  }

  log.warn(`[spot-perp-worker] trade=${tradeId} ${market}: Close incomplete (retry ${retryCount + 1}/${MAX_CLOSE_RETRIES}), perp still open`)

  await db.update(spotPerpTrades)
    .set({ closeRetryCount: retryCount + 1, updatedAt: new Date() })
    .where(eq(spotPerpTrades.id, tradeId))

  await triggerClose(jobData, trade.closeReason ?? 'error', `Retry #${retryCount + 1}: perp still open`)
  return { checked: true, closeTriggered: true }
}

// ---------------------------------------------------------------------------
// Trigger close via backend API + confirm spot transaction
// ---------------------------------------------------------------------------

async function triggerClose(
  jobData: SpotPerpCheckJobData,
  closeReason: string,
  closeDetails: string,
): Promise<void> {
  const { tradeId, market, spotTokenMint, perpProtocol, privyUserId } = jobData

  log.warn(`[spot-perp-worker] AUTO-CLOSE trade=${tradeId} ${market}: reason=${closeReason} | ${closeDetails}`)
  sendOpsAlert({
    key: `spot-perp-auto-close-${tradeId}`,
    severity: AlertSeverity.WARNING,
    title: 'Spot-perp position auto-close triggered',
    message: `trade=${tradeId} ${market}: reason=${closeReason} | ${closeDetails}`,
    service: 'core-worker',
  })

  if (jobData.status !== 'closing') {
    try {
      await db.update(spotPerpTrades)
        .set({
          status: 'closing',
          closeReason: closeReason as any,
          updatedAt: new Date(),
        })
        .where(eq(spotPerpTrades.id, tradeId))
    } catch (e) {
      log.error(`[spot-perp-worker] trade=${tradeId}: Failed to set closing status:`, e)
    }
  }

  for (let attempt = 1; attempt <= SPOT_CONFIRM_MAX_RETRIES; attempt++) {
    const result = await fireCloseRequest(tradeId, market, spotTokenMint, perpProtocol, privyUserId, closeReason)
    if (!result) return // request itself failed, bail to producer retry

    // If spot had an error at send time (slippage, no liquidity, etc.), retry immediately
    if (result.spotError) {
      log.warn(`[spot-perp-worker] trade=${tradeId} ${market}: Spot sell failed (attempt ${attempt}/${SPOT_CONFIRM_MAX_RETRIES}): ${result.spotError}`)
      if (attempt < SPOT_CONFIRM_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, SPOT_CONFIRM_POLL_MS))
        continue
      }
      return // exhausted retries, producer will pick up later
    }

    // Spot transaction was sent — confirm it landed on-chain
    if (result.closeSpotTxnHash && !result.spotError) {
      const confirmed = await confirmSpotTransaction(tradeId, market, result.closeSpotTxnHash)
      if (confirmed) {
        log.info(`[spot-perp-worker] trade=${tradeId} ${market}: Spot sell confirmed: ${result.closeSpotTxnHash}`)
        return // done
      }

      // Not confirmed — retry with fresh quote
      log.warn(`[spot-perp-worker] trade=${tradeId} ${market}: Spot tx not confirmed (attempt ${attempt}/${SPOT_CONFIRM_MAX_RETRIES})`)
      if (attempt < SPOT_CONFIRM_MAX_RETRIES) {
        // Clear stale spot hash so executor retries the sell
        try {
          await db.update(spotPerpTrades)
            .set({ closeSpotTxnHash: null, updatedAt: new Date() })
            .where(eq(spotPerpTrades.id, tradeId))
        } catch {}
        continue
      }
      return // exhausted retries
    }

    // No spot hash and no error = spot was already closed or skipped
    return
  }
}

/** Fire a single close request to the API service */
async function fireCloseRequest(
  tradeId: number, market: string, spotTokenMint: string,
  perpProtocol: string, privyUserId: string, closeReason: string,
): Promise<{ success: boolean; closeSpotTxnHash?: string; closePerpTxnHash?: string; spotError?: string; perpError?: string } | null> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/internal/spot-perp/close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({ tradeId, market, spotTokenMint, perpProtocol, privyUserId, closeReason }),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown')
      log.error(`[spot-perp-worker] trade=${tradeId}: Auto-close failed (HTTP ${response.status}): ${errorText}`)
      sendOpsAlert({
        key: `spot-perp-close-failed-${tradeId}`,
        severity: AlertSeverity.WARNING,
        title: 'Spot-perp auto-close API call failed',
        message: `trade=${tradeId} ${market}: HTTP ${response.status} — ${errorText}`,
        service: 'core-worker',
      })
      await db.update(spotPerpTrades)
        .set({ closeError: `Auto-close failed: ${errorText}`, updatedAt: new Date() })
        .where(eq(spotPerpTrades.id, tradeId))
        .catch(() => {})
      return null
    }

    const result = await response.json().catch(() => ({}))
    log.info(`[spot-perp-worker] trade=${tradeId} ${market}: Close response: ${JSON.stringify(result)}`)
    return result
  } catch (e) {
    log.error(`[spot-perp-worker] trade=${tradeId}: Close request failed:`, e)
    sendOpsAlert({
      key: `spot-perp-close-failed-${tradeId}`,
      severity: AlertSeverity.WARNING,
      title: 'Spot-perp close request failed',
      message: `trade=${tradeId} ${market}: ${e instanceof Error ? e.message : String(e)}`,
      service: 'core-worker',
      error: e,
    })
    await db.update(spotPerpTrades)
      .set({ closeError: `Auto-close request failed: ${e instanceof Error ? e.message : 'unknown'}`, updatedAt: new Date() })
      .where(eq(spotPerpTrades.id, tradeId))
      .catch(() => {})
    return null
  }
}

/** Poll Solana RPC to check if a spot sell transaction confirmed */
async function confirmSpotTransaction(tradeId: number, market: string, txHash: string): Promise<boolean> {
  for (let poll = 0; poll < SPOT_CONFIRM_MAX_POLLS; poll++) {
    await new Promise(r => setTimeout(r, SPOT_CONFIRM_POLL_MS))
    try {
      const statuses = await connection.getSignatureStatuses([txHash])
      const status = statuses.value[0]
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        if (status.err) {
          log.error(`[spot-perp-worker] trade=${tradeId} ${market}: Spot tx failed on-chain: ${JSON.stringify(status.err)}`)
          return false
        }
        return true
      }
    } catch (e) {
      log.warn(`[spot-perp-worker] trade=${tradeId}: Confirmation poll error:`, e)
    }
  }
  log.warn(`[spot-perp-worker] trade=${tradeId} ${market}: Spot tx ${txHash} not confirmed after ${SPOT_CONFIRM_MAX_POLLS * SPOT_CONFIRM_POLL_MS / 1000}s`)
  return false
}

export function startSpotPerpWorker() {
  const worker = new Worker<SpotPerpCheckJobData>(
    SPOT_PERP_QUEUE_NAME,
    async (job) => processSpotPerpCheck(job.data),
    { connection: redisConnectionOptions, concurrency: 5 },
  )

  worker.on('failed', (job, err) => {
    log.error(`[spot-perp-worker] Job ${job?.id} failed:`, err.message)
    sendOpsAlert({
      key: 'spot-perp-job-failed',
      severity: AlertSeverity.WARNING,
      title: 'Spot-perp worker job failed',
      message: `Job ${job?.id}: ${err.message}`,
      service: 'core-worker',
    })
  })

  worker.on('error', (err) => {
    log.error('[spot-perp-worker] Worker error:', err)
    sendOpsAlert({
      key: 'spot-perp-worker-error',
      severity: AlertSeverity.WARNING,
      title: 'Spot-perp worker error',
      message: err instanceof Error ? err.message : String(err),
      service: 'core-worker',
      error: err,
    })
  })

  log.info('[spot-perp-worker] Started')
}
