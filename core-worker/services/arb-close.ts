import { pairLabel, type ArbPositionCheckJobData } from '../queue/arb-types'
import { db } from '@paystream/db'
import { arbPositionPairs, arbCloseReasonEnum } from '@paystream/db/schema'
import { eq } from 'drizzle-orm'
import { log } from '../utils/log'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:9090'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

type ArbCloseReason = (typeof arbCloseReasonEnum.enumValues)[number]

export async function triggerClose(
  jobData: ArbPositionCheckJobData,
  closeReason: ArbCloseReason,
  closeDetails: string,
): Promise<void> {
  const { pairId, symbol, longSymbol, shortSymbol, longProtocol, shortProtocol, privyUserId } = jobData
  const label = pairLabel(jobData)

  log.warn(`[arb-close] AUTO-CLOSE pair=${pairId} ${label}: reason=${closeReason} | ${closeDetails}`)
  sendOpsAlert({
    key: `arb-auto-close-${pairId}`,
    severity: AlertSeverity.WARNING,
    title: 'Arb position auto-close triggered',
    message: `pair=${pairId} ${label}: reason=${closeReason} | ${closeDetails}`,
    service: 'core-worker',
  })

  if (jobData.status !== 'closing') {
    try {
      await db.update(arbPositionPairs)
        .set({
          status: 'closing',
          closeReason,
          updatedAt: new Date(),
        })
        .where(eq(arbPositionPairs.id, pairId))
    } catch (e) {
      log.error(`[arb-close] pair=${pairId}: Failed to set closing status:`, e)
    }
  }

  try {
    const response = await fetch(`${BACKEND_URL}/api/internal/arb/close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({
        pairId,
        // `market` kept for back-compat with older close endpoints; per-leg
        // protocol+ticker pairs sent alongside for cross-ticker pairs.
        market: symbol,
        longProtocol,
        longSymbol,
        shortProtocol,
        shortSymbol,
        protocols: [longProtocol, shortProtocol],
        privyUserId,
        closeReason,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown')
      log.error(`[arb-close] pair=${pairId}: Auto-close failed (HTTP ${response.status}): ${errorText}`)
      sendOpsAlert({
        key: `arb-close-failed-${pairId}`,
        severity: AlertSeverity.WARNING,
        title: 'Arb auto-close API call failed',
        message: `pair=${pairId} ${label}: HTTP ${response.status} — ${errorText}`,
        service: 'core-worker',
      })
      await db.update(arbPositionPairs)
        .set({ closeError: `Auto-close failed: ${errorText}`, updatedAt: new Date() })
        .where(eq(arbPositionPairs.id, pairId))
    } else {
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string }
      if (result.success === false) {
        // Executor reached and ran, but one or more legs failed. It already
        // recorded closeError on the pair and left status='closing'; flag it
        // for ops and let the producer's stale-closing retry loop take over.
        log.error(`[arb-close] pair=${pairId} ${label}: Close returned failure: ${result.error ?? 'unknown'}`)
        sendOpsAlert({
          key: `arb-close-leg-failed-${pairId}`,
          severity: AlertSeverity.WARNING,
          title: 'Arb close had leg failures',
          message: `pair=${pairId} ${label}: ${result.error ?? 'unknown'}`,
          service: 'core-worker',
        })
      } else {
        log.info(`[arb-close] pair=${pairId} ${label}: Close response: ${JSON.stringify(result)}`)
      }
    }
  } catch (e) {
    log.error(`[arb-close] pair=${pairId}: Close request failed:`, e)
    sendOpsAlert({
      key: `arb-close-failed-${pairId}`,
      severity: AlertSeverity.WARNING,
      title: 'Arb close request failed',
      message: `pair=${pairId} ${label}: ${e instanceof Error ? e.message : String(e)}`,
      service: 'core-worker',
      error: e,
    })
    try {
      await db.update(arbPositionPairs)
        .set({
          closeError: `Auto-close request failed: ${e instanceof Error ? e.message : 'unknown'}`,
          updatedAt: new Date(),
        })
        .where(eq(arbPositionPairs.id, pairId))
    } catch {}
  }
}
