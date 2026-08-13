import type { Context } from 'hono'
import { db } from '@paystream/db'
import { notifications } from '@paystream/db/schema'
import { and, count, desc, eq } from 'drizzle-orm'
import { log } from '../../utils/log'

/**
 * GET /api/notifications
 * Returns user notifications with pagination.
 * Query params: limit (1-100, default 50), offset (default 0), unread (boolean)
 */
export async function notificationsListHandler(c: Context) {
  try {
    const authData = c.privyUser
    if (!authData) {
      return c.json({ status: 'error', message: 'Authentication required' }, 401)
    }

    const privyUserId = authData.user.id

    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100)
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
    const unreadOnly = c.req.query('unread') === 'true'

    const conditions = [eq(notifications.privyUserId, privyUserId)]
    if (unreadOnly) {
      conditions.push(eq(notifications.read, false))
    }

    const where = and(...conditions)

    const [rows, [countRow], [unreadCountRow]] = await Promise.all([
      db
        .select({
          id: notifications.id,
          type: notifications.type,
          data: notifications.data,
          read: notifications.read,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt))
        .limit(limit)
        .offset(offset),

      db
        .select({ count: count() })
        .from(notifications)
        .where(where),

      db
        .select({ count: count() })
        .from(notifications)
        .where(
          and(
            eq(notifications.privyUserId, privyUserId),
            eq(notifications.read, false),
          )
        ),
    ])

    const total = countRow?.count ?? 0
    const unreadCount = unreadCountRow?.count ?? 0

    return c.json({
      status: 'success',
      notifications: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
      unreadCount,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + limit < total,
      },
    })
  } catch (err) {
    log.error('Failed to fetch notifications:', err)
    return c.json(
      { status: 'error', message: 'Failed to fetch notifications' },
      500,
    )
  }
}
