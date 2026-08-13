import { Queue } from 'bullmq'
import { queueOptions } from './config'
import { SPOT_PERP_QUEUE_NAME, SPOT_PERP_PRODUCER_INTERVAL_MS } from './spot-perp-config'
import type { SpotPerpCheckJobData } from './spot-perp-types'
import { db } from '@paystream/db'
import { spotPerpTrades } from '@paystream/db/schema'
import { eq, and, lt } from 'drizzle-orm'
import { log } from '../utils/log'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'

const spotPerpQueue = new Queue<SpotPerpCheckJobData>(SPOT_PERP_QUEUE_NAME, queueOptions)

/** How long a trade can stay in 'closing' before we consider it stuck (ms) */
const CLOSING_STALE_THRESHOLD_MS = 60_000

async function produceSpotPerpCheckJobs() {
  try {
    const activeTrades = await db.select().from(spotPerpTrades)
      .where(and(
        eq(spotPerpTrades.active, true),
        eq(spotPerpTrades.status, 'open'),
      ))

    const staleClosingCutoff = new Date(Date.now() - CLOSING_STALE_THRESHOLD_MS)
    const closingTrades = await db.select().from(spotPerpTrades)
      .where(and(
        eq(spotPerpTrades.active, true),
        eq(spotPerpTrades.status, 'closing'),
        lt(spotPerpTrades.updatedAt, staleClosingCutoff),
      ))

    if (activeTrades.length === 0 && closingTrades.length === 0) return

    for (const trade of activeTrades) {
      const jobData: SpotPerpCheckJobData = {
        tradeId: Number(trade.id),
        market: trade.market,
        spotTokenMint: trade.spotTokenMint,
        perpProtocol: trade.perpProtocol,
        perpTxnHash: trade.perpTxnHash,
        perpLiquidationPrice: trade.perpLiquidationPrice,
        perpMarginUsd: trade.perpMarginUsd,
        perpNotionalUsd: trade.perpNotionalUsd,
        perpLeverage: trade.perpLeverage,
        sizeAsset: trade.sizeAsset,
        privyUserId: trade.privyUserId,
        userPubkey: trade.userPubkey,
        ethAddress: trade.ethAddress,
        createdAt: trade.createdAt.toISOString(),
        status: 'open',
      }

      await spotPerpQueue.add(
        `spot-perp-check-${trade.id}`,
        jobData,
        {
          jobId: `spot-perp-${trade.id}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      )
    }

    for (const trade of closingTrades) {
      log.warn(`[spot-perp-producer] Retrying stuck close: trade=${trade.id} ${trade.market} retries=${trade.closeRetryCount}`)

      const jobData: SpotPerpCheckJobData = {
        tradeId: Number(trade.id),
        market: trade.market,
        spotTokenMint: trade.spotTokenMint,
        perpProtocol: trade.perpProtocol,
        perpTxnHash: trade.perpTxnHash,
        perpLiquidationPrice: trade.perpLiquidationPrice,
        perpMarginUsd: trade.perpMarginUsd,
        perpNotionalUsd: trade.perpNotionalUsd,
        perpLeverage: trade.perpLeverage,
        sizeAsset: trade.sizeAsset,
        privyUserId: trade.privyUserId,
        userPubkey: trade.userPubkey,
        ethAddress: trade.ethAddress,
        createdAt: trade.createdAt.toISOString(),
        status: 'closing',
      }

      await spotPerpQueue.add(
        `spot-perp-retry-${trade.id}`,
        jobData,
        {
          jobId: `spot-perp-retry-${trade.id}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      )
    }
  } catch (error) {
    log.error('[spot-perp-producer] Error producing jobs:', error)
    sendOpsAlert({
      key: 'spot-perp-producer-error',
      severity: AlertSeverity.WARNING,
      title: 'Spot-perp producer failed to enqueue jobs',
      message: error instanceof Error ? error.message : String(error),
      service: 'core-worker',
      error,
    })
  }
}

export async function startSpotPerpProducer(intervalMs?: number) {
  const interval = intervalMs || SPOT_PERP_PRODUCER_INTERVAL_MS
  log.info(`[spot-perp-producer] Started (interval: ${interval}ms)`)
  await produceSpotPerpCheckJobs()
  setInterval(produceSpotPerpCheckJobs, interval)
}
