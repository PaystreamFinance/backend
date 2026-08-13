import type { Context } from 'hono'
import { broadcastMessage } from '../../services/notifications.js'
import { log } from '../../../utils/log.js'

/**
 * POST /broadcast
 * Sends a message to all linked users with notifications enabled.
 * Body: { message: string, type?: string, parseMode?: 'MarkdownV2' | 'HTML' }
 */
export async function broadcastHandler(c: Context) {
  try {
    const { message, parseMode } = await c.req.json()

    if (!message) {
      return c.json({ status: 'error', message: 'Missing required field: message' }, 400)
    }

    const result = await broadcastMessage(message, parseMode ?? 'MarkdownV2')

    log.info(`[api/broadcast] sent=${result.sent} failed=${result.failed}`)
    return c.json({ status: 'ok', ...result })
  } catch (error) {
    log.error('[api/broadcast] Error:', error)
    return c.json(
      { status: 'error', message: error instanceof Error ? error.message : 'Unknown error' },
      500,
    )
  }
}
