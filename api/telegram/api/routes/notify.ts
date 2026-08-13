import type { Context } from 'hono'
import { sendNotification } from '../../services/notifications.js'
import { log } from '../../../utils/log.js'

/**
 * POST /notify
 * Sends a notification to a specific user by their Privy user ID.
 * Body: { privyUserId: string, type: string, data: Record<string, unknown> }
 */
export async function notifyHandler(c: Context) {
  try {
    const { privyUserId, type, data } = await c.req.json()

    if (!privyUserId || !type) {
      return c.json({ status: 'error', message: 'Missing required fields: privyUserId, type' }, 400)
    }

    const result = await sendNotification(privyUserId, type, data ?? {})

    log.info(`[api/notify] type=${type} user=${privyUserId} sent=${result.sent}`)
    return c.json({ status: 'ok', ...result })
  } catch (error) {
    log.error('[api/notify] Error:', error)
    return c.json(
      { status: 'error', message: error instanceof Error ? error.message : 'Unknown error' },
      500,
    )
  }
}
