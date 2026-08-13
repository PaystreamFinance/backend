import type { ArbPositionCheckJobData } from '../queue/arb-types'
import { log } from '../utils/log'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:9090'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

export interface TriggerSetStopLossResult {
  ok: boolean
  direction?: 'long' | 'short'
  error?: string
}

/**
 * Ride-to-liquidation flow: worker calls back into the API to set a tight
 * stop-loss on the surviving leg after the other leg has been liquidated.
 */
export async function triggerSetStopLoss(
  jobData: ArbPositionCheckJobData,
  protocol: string,
  market: string,
  stopPrice: number,
): Promise<TriggerSetStopLossResult> {
  const { pairId, privyUserId } = jobData

  log.warn(`[arb-set-sl] pair=${pairId} ${protocol}/${market} stopPrice=$${stopPrice.toFixed(6)}`)

  try {
    const response = await fetch(`${BACKEND_URL}/api/internal/arb/set-stop-loss`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({
        pairId,
        market,
        protocol,
        stopPrice,
        privyUserId,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown')
      log.error(`[arb-set-sl] pair=${pairId}: SL placement failed (HTTP ${response.status}): ${errorText}`)
      sendOpsAlert({
        key: `arb-set-sl-failed-${pairId}`,
        severity: AlertSeverity.WARNING,
        title: 'Arb surviving-leg SL placement failed',
        message: `pair=${pairId} ${protocol}/${market}: HTTP ${response.status} — ${errorText}`,
        service: 'core-worker',
      })
      return { ok: false, error: `HTTP ${response.status}: ${errorText}` }
    }

    const result = await response.json().catch(() => ({})) as { success?: boolean; direction?: 'long' | 'short'; error?: string }
    if (!result.success) {
      log.error(`[arb-set-sl] pair=${pairId}: SL placement returned failure: ${result.error}`)
      sendOpsAlert({
        key: `arb-set-sl-failed-${pairId}`,
        severity: AlertSeverity.WARNING,
        title: 'Arb surviving-leg SL placement failed',
        message: `pair=${pairId} ${protocol}/${market}: ${result.error || 'unknown error'}`,
        service: 'core-worker',
      })
      return { ok: false, error: result.error || 'unknown error' }
    }

    log.info(`[arb-set-sl] pair=${pairId}: SL placed on ${protocol} ${result.direction} @ $${stopPrice.toFixed(6)}`)
    return { ok: true, direction: result.direction }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e)
    log.error(`[arb-set-sl] pair=${pairId}: SL request failed:`, e)
    sendOpsAlert({
      key: `arb-set-sl-failed-${pairId}`,
      severity: AlertSeverity.WARNING,
      title: 'Arb surviving-leg SL request failed',
      message: `pair=${pairId} ${protocol}/${market}: ${errorMsg}`,
      service: 'core-worker',
      error: e,
    })
    return { ok: false, error: errorMsg }
  }
}
