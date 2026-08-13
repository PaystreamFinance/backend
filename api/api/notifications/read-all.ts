import type { Context } from 'hono'
import { db } from '@paystream/db'
import { notifications } from '@paystream/db/schema'
import { and, eq } from 'drizzle-orm'
import { log } from '../../utils/log'

/**
 * POST /api/notifications/read-all
 * Mark all unread notifications as read for the authenticated user.
 */
export async function notificationsReadAllHandler(c: Context) {
  try {
    const authData = c.privyUser
    if (!authData) {
      return c.json({ status: 'error', message: 'Authentication required' }, 401)
    }

    const privyUserId = authData.user.id

    const result = await db
      .update(notifications)
      .set({ read: true })
      .where(
        and(
          eq(notifications.privyUserId, privyUserId),
          eq(notifications.read, false),
        ),
      )
      .returning({ id: notifications.id })

    return c.json({ status: 'success', marked: result.length })
  } catch (err) {
    log.error('Failed to mark all notifications as read:', err)
    return c.json(
      { status: 'error', message: 'Failed to mark notifications as read' },
      500,
    )
  }
}
