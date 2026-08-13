import { log } from './log'
import { db } from '@paystream/db'
import { notifications } from '@paystream/db/schema'
import { createHash } from 'crypto'

const TELEGRAM_BOT_URL = process.env.BACKEND_URL || 'http://localhost:9090'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

/** Recursively sort object keys for deterministic JSON serialization */
function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

function buildDedupeKey(type: string, data: Record<string, unknown>): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(sortKeys({ type, data })))
    .digest('hex')
    .slice(0, 32)
  return `${type}:${hash}`
}

/**
 * Persist notification to DB first, then dispatch to Telegram.
 * Never throws — logs errors silently to avoid disrupting worker flow.
 */
export async function notifyTelegram(
  privyUserId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const dedupeKey = buildDedupeKey(type, data)
    await db.insert(notifications)
      .values({
        privyUserId,
        type: type as typeof notifications.$inferInsert.type,
        data,
        dedupeKey,
      })
      .onConflictDoNothing({ target: [notifications.privyUserId, notifications.dedupeKey] })
    log.info(`[notify] Stored ${type} notification for web`)
  } catch (error) {
    log.warn(`[notify] Failed to store ${type} notification in DB:`, error)
  }

  fetch(`${TELEGRAM_BOT_URL}/api/telegram/bot/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-service-key': INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify({ privyUserId, type, data }),
  }).catch((error) => {
    log.warn(`[notify] Failed to send ${type} to Telegram:`, error)
  })
}
