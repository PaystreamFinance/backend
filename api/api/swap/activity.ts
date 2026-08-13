import type { Context } from 'hono'
import type {
  SwapRecord,
  SwapActivitySuccessResponse,
  SwapActivityErrorResponse,
} from '../../models/swap'
import { db } from '@paystream/db'
import { swaps } from '@paystream/db/schema'
import { count, desc, eq } from 'drizzle-orm'
import { log } from '../../utils/log'

/**
 * GET /api/swap/activity
 * Returns swap history with pagination
 */
export async function swapActivityHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      const response: SwapActivityErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const privyUserId = authData.user.id

    const limitParam = c.req.query('limit')
    const offsetParam = c.req.query('offset')

    const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 100)
    const offset = Math.max(Number(offsetParam) || 0, 0)

    const baseCondition = eq(swaps.privyUserId, privyUserId)

    const [rows, [countRow]] = await Promise.all([
      db
        .select()
        .from(swaps)
        .where(baseCondition)
        .orderBy(desc(swaps.createdAt))
        .limit(limit)
        .offset(offset),

      db
        .select({ count: count() })
        .from(swaps)
        .where(baseCondition),
    ])

    const total = countRow?.count ?? 0

    const mappedSwaps: SwapRecord[] = rows.map((row) => ({
      publicId: row.publicId,
      inputMint: row.inputMint,
      outputMint: row.outputMint,
      inAmount: row.inAmount,
      outAmount: row.outAmount,
      txHash: row.txHash,
      createdAt: row.createdAt.toISOString(),
    }))

    const response: SwapActivitySuccessResponse = {
      status: 'success',
      swaps: mappedSwaps,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + limit < total,
      },
    }

    return c.json(response)
  } catch (err) {
    log.error('Failed to fetch swap activity:', err)
    const response: SwapActivityErrorResponse = {
      status: 'error',
      message: 'Failed to fetch swap activity',
      error: err instanceof Error ? err.message : String(err),
    }
    return c.json(response, 500)
  }
}
