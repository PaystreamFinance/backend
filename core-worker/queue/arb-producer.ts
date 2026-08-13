import { Queue } from 'bullmq'
import { queueOptions } from './config'
import { ARB_QUEUE_NAME, ARB_PRODUCER_INTERVAL_MS } from './arb-config'
import { type ArbPositionCheckJobData, pairToJobData } from './arb-types'
import { db } from '@paystream/db'
import { arbPositionPairs } from '@paystream/db/schema'
import { eq, and, lt } from 'drizzle-orm'
import { log } from '../utils/log'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'
import { checkPortfolioEquity } from '../services/arb-equity-check'
import { isHip3ProtocolId } from '@paystream/perps/hip3/dex-config'

const arbQueue = new Queue<ArbPositionCheckJobData>(ARB_QUEUE_NAME, queueOptions)

/** How long a pair can stay in 'closing' before we consider it stuck (ms) */
const CLOSING_STALE_THRESHOLD_MS = 60_000

/** Base protocols supported by the worker + close-executor. Legacy pairs
 * with a leg on any other protocol (e.g. drift) get parked in status='error'
 * so they stop cycling through the queue and flagging position-fetch warnings.
 * Curated HIP-3 dexes are accepted via `hl:<name>` protocol ids. */
const SUPPORTED_BASE_PROTOCOLS = new Set(['pacifica', 'hyperliquid', 'aster', 'lighter', '01', 'phoenix'])

function isSupportedProtocol(protocol: string): boolean {
  return SUPPORTED_BASE_PROTOCOLS.has(protocol) || isHip3ProtocolId(protocol)
}

function findUnsupportedLeg(
  pair: { longProtocol: string; shortProtocol: string },
): { leg: 'long' | 'short'; protocol: string } | null {
  if (!isSupportedProtocol(pair.longProtocol)) return { leg: 'long', protocol: pair.longProtocol }
  if (!isSupportedProtocol(pair.shortProtocol)) return { leg: 'short', protocol: pair.shortProtocol }
  return null
}

async function produceArbCheckJobs() {
  try {
    const activePairs = await db.select().from(arbPositionPairs)
      .where(and(
        eq(arbPositionPairs.active, true),
        eq(arbPositionPairs.status, 'open'),
      ))

    const staleClosingCutoff = new Date(Date.now() - CLOSING_STALE_THRESHOLD_MS)
    const closingPairs = await db.select().from(arbPositionPairs)
      .where(and(
        eq(arbPositionPairs.active, true),
        eq(arbPositionPairs.status, 'closing'),
        lt(arbPositionPairs.updatedAt, staleClosingCutoff),
      ))

    if (activePairs.length === 0 && closingPairs.length === 0) return

    const healthyPairs: typeof activePairs = []
    for (const pair of activePairs) {
      // Pairs with disableAutoclose opt out of all worker monitoring — they
      // can only be closed manually or via venue liquidation.
      if (pair.disableAutoclose) continue
      const unsupported = findUnsupportedLeg(pair)
      if (unsupported) {
        const errorMsg = `Unsupported protocol on ${unsupported.leg} leg: ${unsupported.protocol}. Manual close required on that exchange.`
        log.warn(`[arb-producer] Parking pair=${pair.id} ${pair.symbol}: ${errorMsg}`)
        sendOpsAlert({
          key: `arb-unsupported-leg-${pair.id}`,
          severity: AlertSeverity.WARNING,
          title: 'Arb pair has unsupported leg',
          message: `pair=${pair.id} ${pair.symbol} long=${pair.longProtocol} short=${pair.shortProtocol}`,
          service: 'core-worker',
        })
        await db.update(arbPositionPairs)
          .set({ status: 'error', closeError: errorMsg, updatedAt: new Date() })
          .where(eq(arbPositionPairs.id, pair.id))
        continue
      }
      healthyPairs.push(pair)
    }

    for (const pair of healthyPairs) {
      await arbQueue.add(
        `arb-check-${pair.id}`,
        pairToJobData(pair, 'open'),
        { jobId: `arb-${pair.id}`, removeOnComplete: true, removeOnFail: true },
      )
    }

    for (const pair of closingPairs) {
      log.warn(`[arb-producer] Retrying stuck close: pair=${pair.id} ${pair.symbol} retries=${pair.closeRetryCount}`)

      await arbQueue.add(
        `arb-retry-${pair.id}`,
        pairToJobData(pair, 'closing'),
        { jobId: `arb-retry-${pair.id}`, removeOnComplete: true, removeOnFail: true },
      )
    }

    // Portfolio-level equity drawdown check (fire-and-forget to avoid blocking producer cycle)
    if (healthyPairs.length > 0) {
      checkPortfolioEquity(healthyPairs).catch(e =>
        log.error('[arb-producer] Equity check error:', e)
      )
    }
  } catch (error) {
    log.error('[arb-producer] Error producing jobs:', error)
    sendOpsAlert({
      key: 'arb-producer-error',
      severity: AlertSeverity.WARNING,
      title: 'Arb producer failed to enqueue jobs',
      message: error instanceof Error ? error.message : String(error),
      service: 'core-worker',
      error,
    })
  }
}

export async function startArbProducer(intervalMs?: number) {
  const interval = intervalMs || ARB_PRODUCER_INTERVAL_MS
  log.info(`[arb-producer] Started (interval: ${interval}ms)`)
  await produceArbCheckJobs()
  setInterval(produceArbCheckJobs, interval)
}
