import { log } from '../utils/log'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'
import { collectAndStoreFundingRates } from './service'

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

let schedulerInterval: NodeJS.Timeout | null = null
let isRunning = false

async function runCollection(): Promise<void> {
  if (isRunning) {
    log('[funding-rates] Collection already in progress, skipping...')
    return
  }

  isRunning = true
  try {
    await collectAndStoreFundingRates()
  } catch (error) {
    log.error('[funding-rates] Error during collection:', error)
    sendOpsAlert({
      key: 'funding-scheduler-error',
      severity: AlertSeverity.CRITICAL,
      title: 'Funding rates scheduler error',
      message: error instanceof Error ? error.message : String(error),
      service: 'core-worker',
      error,
    })
  } finally {
    isRunning = false
  }
}

export function startFundingRatesScheduler(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void {
  if (schedulerInterval) {
    log('[funding-rates] Scheduler already running')
    return
  }

  const intervalMinutes = (intervalMs / 1000 / 60).toFixed(1)
  log(`[funding-rates] Scheduler started (interval: ${intervalMinutes} minutes, lookback: 30d)`)
  runCollection()
  schedulerInterval = setInterval(runCollection, intervalMs)
}

export function stopFundingRatesScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
    log('[funding-rates] Scheduler stopped')
  }
}

export function isSchedulerRunning(): boolean {
  return schedulerInterval !== null
}

export function getConfiguredInterval(): number {
  const raw = process.env.FUNDING_RATES_INTERVAL_MS
  if (!raw) return DEFAULT_INTERVAL_MS
  const parsed = parseInt(raw, 10)
  return !isNaN(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS
}
