import { db } from '@paystream/db'
import { arbPositionPairs } from '@paystream/db/schema'
import type { RiskParams } from '@paystream/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { log } from '../utils/log'
import { notifyTelegram } from '../utils/telegram-notify'
import { triggerClose } from './arb-close'
import { computeEquityDrawdownTag, worstTag } from './arb-risk-tags'
import { pairToJobData } from '../queue/arb-types'

type ArbPairRow = typeof arbPositionPairs.$inferSelect

/**
 * Portfolio-level equity drawdown check.
 * Groups active pairs by user, computes drawdown, updates tags,
 * and triggers close-all if CRITICAL.
 */
export async function checkPortfolioEquity(activePairs: ArbPairRow[]): Promise<void> {
  // disableAclp pairs are excluded — their intentional drawdown must not poison
  // the per-user calc nor trigger close-all on the user's other healthy pairs.
  // disableAutoclose pairs are excluded for the same reason — they're fully
  // opted out of worker-driven closes.
  const filteredPairs = activePairs.filter(p => !p.disableAclp && !p.disableAutoclose)
  if (filteredPairs.length === 0) return

  const byUser = new Map<string, ArbPairRow[]>()
  for (const pair of filteredPairs) {
    const existing = byUser.get(pair.privyUserId)
    if (existing) {
      existing.push(pair)
    } else {
      byUser.set(pair.privyUserId, [pair])
    }
  }

  for (const [privyUserId, userPairs] of byUser) {
    try {
      await checkUserEquity(privyUserId, userPairs)
    } catch (e) {
      log.error(`[arb-equity] Error checking equity for user=${privyUserId}:`, e)
    }
  }
}

async function checkUserEquity(privyUserId: string, userPairs: ArbPairRow[]): Promise<void> {
  let initialEquity = 0
  let currentEquity = 0
  let hasCurrentData = true

  for (const pair of userPairs) {
    initialEquity += pair.longMarginUsd + pair.shortMarginUsd

    if (pair.currentLongMarginUsd === null || pair.currentShortMarginUsd === null) {
      hasCurrentData = false
      break
    }
    currentEquity += pair.currentLongMarginUsd + pair.currentShortMarginUsd
  }

  if (!hasCurrentData || initialEquity === 0) return

  const drawdown = (initialEquity - currentEquity) / initialEquity
  const tag = computeEquityDrawdownTag(drawdown)

  // Re-read fresh riskParams from DB to avoid clobbering worker's concurrent writes
  const pairIds = userPairs.map(p => Number(p.id))
  const freshPairs = await db.select({
    id: arbPositionPairs.id,
    riskParams: arbPositionPairs.riskParams,
  })
    .from(arbPositionPairs)
    .where(inArray(arbPositionPairs.id, pairIds))

  const freshParamsById = new Map(freshPairs.map(p => [Number(p.id), p.riskParams as RiskParams | null]))

  await Promise.all(userPairs.map(async (pair) => {
    try {
      const freshParams = freshParamsById.get(Number(pair.id))
      const existingParams = (freshParams ?? {}) as Partial<RiskParams>
      const updatedParams: RiskParams = {
        liqProximity: existingParams.liqProximity ?? 'normal',
        funding: existingParams.funding ?? 'normal',
        oiCascade: existingParams.oiCascade ?? 'normal',
        equityDrawdown: tag,
      }

      await db.update(arbPositionPairs)
        .set({
          riskParams: updatedParams,
          riskTag: worstTag(updatedParams),
          updatedAt: new Date(),
        })
        .where(eq(arbPositionPairs.id, pair.id))
    } catch (e) {
      log.error(`[arb-equity] Failed to update tags for pair=${pair.id}:`, e)
    }
  }))

  if (tag === 'critical') {
    log.warn(`[arb-equity] CRITICAL equity drawdown for user=${privyUserId}: ${(drawdown * 100).toFixed(2)}% — closing all positions`)

    notifyTelegram(privyUserId, 'auto_close', {
      symbol: 'ALL',
      closeReason: 'equity_drawdown',
      closeDetails: `Portfolio drawdown ${(drawdown * 100).toFixed(2)}% > 5% — closing all ${userPairs.length} positions`,
      longProtocol: 'portfolio',
      shortProtocol: 'portfolio',
      totalMarginUsd: initialEquity,
    })

    await Promise.all(userPairs.map(pair =>
      triggerClose(
        pairToJobData(pair),
        'equity_drawdown',
        `Portfolio drawdown ${(drawdown * 100).toFixed(2)}% > 5%`,
      )
    ))
  }
}
