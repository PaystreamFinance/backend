import type { Context } from 'hono'
import type {
  ArbActivityPosition,
  ArbActivitySuccessResponse,
  ArbActivityErrorResponse,
} from '../../models/arb'
import { db } from '@paystream/db'
import { arbPositionPairs } from '@paystream/db/schema'
import { and, count, desc, eq, sum } from 'drizzle-orm'
import { log } from '../../utils/log'

const VALID_STATUSES = ['open', 'closing', 'closed', 'liquidated', 'error', 'all'] as const

const CLOSE_REASON_LABELS: Record<string, string> = {
  manual: 'Manually Closed',
  funding_flip: 'Funding Rate Flipped',
  pnl_threshold: 'PnL Threshold Reached',
  liquidation_proximity: 'Near Liquidation',
  max_hold_time: 'Max Hold Time Exceeded',
  error: 'Error',
  delta_drift: 'Delta Drift',
  unknown: 'Unknown',
  equity_drawdown: 'Portfolio Equity Drawdown',
  oi_cascade: 'OI Cascade',
  risk_threshold: 'Risk Threshold (3+ Reduce)',
}

/**
 * GET /api/arb/activity
 * Returns historical arb position activity with pagination and summary stats
 */
export async function activityHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      const response: ArbActivityErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const privyUserId = authData.user.id

    // Parse and validate query params
    const statusParam = c.req.query('status') || 'all'
    const limitParam = c.req.query('limit')
    const offsetParam = c.req.query('offset')

    if (!VALID_STATUSES.includes(statusParam as (typeof VALID_STATUSES)[number])) {
      const response: ArbActivityErrorResponse = {
        status: 'error',
        message: `Invalid status filter: "${statusParam}". Must be one of: ${VALID_STATUSES.join(', ')}`,
      }
      return c.json(response, 400)
    }

    const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 100)
    const offset = Math.max(Number(offsetParam) || 0, 0)

    // Build where conditions
    const baseCondition = eq(arbPositionPairs.privyUserId, privyUserId)
    const filterCondition =
      statusParam === 'all'
        ? baseCondition
        : and(baseCondition, eq(arbPositionPairs.status, statusParam as 'open' | 'closing' | 'closed' | 'liquidated' | 'error'))

    // Run 2 parallel DB queries
    const [positions, summaryRows] = await Promise.all([
      // Paginated positions
      db
        .select()
        .from(arbPositionPairs)
        .where(filterCondition)
        .orderBy(desc(arbPositionPairs.createdAt))
        .limit(limit)
        .offset(offset),

      // Summary stats (always unfiltered by status — total count derived from this)
      db
        .select({
          status: arbPositionPairs.status,
          count: count(),
          totalPnl: sum(arbPositionPairs.realizedPnl),
        })
        .from(arbPositionPairs)
        .where(baseCondition)
        .groupBy(arbPositionPairs.status),
    ])

    // Map DB rows to response format
    const mappedPositions: ArbActivityPosition[] = positions.map((row) => ({
      publicId: row.publicId,
      symbol: row.symbol,
      status: row.status,
      long: {
        protocol: row.longProtocol,
        symbol: row.longSymbol ?? row.symbol,
        marginUsd: row.longMarginUsd,
        notionalUsd: row.longNotionalUsd,
        leverage: row.longLeverage,
        entryPrice: row.longEntryPrice,
        liquidationPrice: row.longLiquidationPrice,
        txSignature: row.longTxSignature,
        status: row.longStatus,
      },
      short: {
        protocol: row.shortProtocol,
        symbol: row.shortSymbol ?? row.symbol,
        marginUsd: row.shortMarginUsd,
        notionalUsd: row.shortNotionalUsd,
        leverage: row.shortLeverage,
        entryPrice: row.shortEntryPrice,
        liquidationPrice: row.shortLiquidationPrice,
        txSignature: row.shortTxSignature,
        status: row.shortStatus,
      },
      sizeAsset: row.sizeAsset,
      totalMarginUsd: row.totalMarginUsd,
      closeReason: row.closeReason,
      closeReasonLabel: row.closeReason ? (CLOSE_REASON_LABELS[row.closeReason] ?? null) : null,
      realizedPnl: row.realizedPnl,
      closeLongTx: row.closeLongTx,
      closeShortTx: row.closeShortTx,
      riskTag: row.riskTag ?? null,
      riskParams: row.riskParams ?? null,
      negFundingCount: row.negFundingCount ?? null,
      createdAt: row.createdAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
    }))

    // Build summary from grouped stats
    const countByStatus = { open: 0, closing: 0, closed: 0, liquidated: 0, error: 0 }
    let totalPositions = 0
    let totalRealizedPnl = 0

    for (const row of summaryRows) {
      const s = row.status as keyof typeof countByStatus
      if (s in countByStatus) {
        countByStatus[s] = row.count
      }
      totalPositions += row.count
      totalRealizedPnl += Number(row.totalPnl ?? 0)
    }

    // Derive filtered total from summary (avoids a separate COUNT query)
    const total = statusParam === 'all'
      ? totalPositions
      : countByStatus[statusParam as keyof typeof countByStatus] ?? 0

    const response: ArbActivitySuccessResponse = {
      status: 'success',
      positions: mappedPositions,
      summary: {
        totalPositions,
        totalRealizedPnl,
        countByStatus,
      },
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + limit < total,
      },
    }

    return c.json(response)
  } catch (err) {
    log.error('Failed to fetch arb activity:', err)
    const response: ArbActivityErrorResponse = {
      status: 'error',
      message: 'Failed to fetch arb activity',
      error: err instanceof Error ? err.message : String(err),
    }
    return c.json(response, 500)
  }
}
