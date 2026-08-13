import type { Context } from 'hono'
import { db } from '@paystream/db'
import { notifications } from '@paystream/db/schema'
import { and, eq } from 'drizzle-orm'
import { log } from '../../utils/log'

/**
 * POST /api/notifications/:id/read
 * Mark a single notification as read by id.
 */
export async function notificationReadHandler(c: Context) {
  try {
    const authData = c.privyUser
    if (!authData) {
      return c.json({ status: 'error', message: 'Authentication required' }, 401)
    }

    const privyUserId = authData.user.id
    const id = c.req.param('id')

    if (!id) {
      return c.json({ status: 'error', message: 'Missing notification id' }, 400)
    }

    const result = await db
      .update(notifications)
      .set({ read: true })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.privyUserId, privyUserId),
        ),
      )
      .returning({ id: notifications.id })

    if (result.length === 0) {
      return c.json({ status: 'error', message: 'Notification not found' }, 404)
    }

    return c.json({ status: 'success' })
  } catch (err) {
    log.error('Failed to mark notification as read:', err)
    return c.json(
      { status: 'error', message: 'Failed to mark notification as read' },
      500,
    )
  }
}
