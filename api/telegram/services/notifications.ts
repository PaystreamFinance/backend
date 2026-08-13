import type { Bot } from 'grammy'
import { db } from '@paystream/db'
import { telegramUserLinks, telegramNotificationPreferences } from '@paystream/db/schema'
import { eq, and } from 'drizzle-orm'
import { formatNotification } from './formatters.js'
import { log } from '../../utils/log.js'

let botInstance: Bot | null = null

export function setBotInstance(bot: Bot) {
  botInstance = bot
}

/**
 * Send a notification to a user by their Privy user ID.
 * Checks linking + notification preferences before sending.
 */
export async function sendNotification(
  privyUserId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<{ sent: boolean; reason?: string }> {
  if (!botInstance) {
    return { sent: false, reason: 'Bot not initialized' }
  }

  const [link] = await db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.privyUserId, privyUserId))
    .limit(1)

  if (!link) {
    return { sent: false, reason: 'User not linked' }
  }

  if (!link.notificationsEnabled) {
    return { sent: false, reason: 'Notifications disabled' }
  }

  // Check per-type preference
  const [pref] = await db
    .select()
    .from(telegramNotificationPreferences)
    .where(
      and(
        eq(telegramNotificationPreferences.privyUserId, privyUserId),
        eq(telegramNotificationPreferences.notificationType, type),
      ),
    )
    .limit(1)

  if (pref && !pref.enabled) {
    return { sent: false, reason: `Notification type '${type}' disabled` }
  }

  const message = formatNotification(type, data)

  try {
    await botInstance.api.sendMessage(link.telegramChatId, message, {
      parse_mode: 'MarkdownV2',
    })
    log.info(`[notify] Sent ${type} to user=${privyUserId} chat=${link.telegramChatId}`)
    return { sent: true }
  } catch (error) {
    log.error(`[notify] Failed to send ${type} to user=${privyUserId}:`, error)
    return { sent: false, reason: error instanceof Error ? error.message : 'Send failed' }
  }
}

/**
 * Broadcast a message to all linked users with notifications enabled.
 * Rate-limited to ~30 msg/sec per Telegram limits.
 */
export async function broadcastMessage(
  message: string,
  parseMode: 'MarkdownV2' | 'HTML' = 'MarkdownV2',
): Promise<{ sent: number; failed: number }> {
  if (!botInstance) {
    return { sent: 0, failed: 0 }
  }

  const links = await db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.notificationsEnabled, true))

  let sent = 0
  let failed = 0

  for (const link of links) {
    try {
      await botInstance.api.sendMessage(link.telegramChatId, message, {
        parse_mode: parseMode,
      })
      sent++
    } catch (error) {
      log.error(`[broadcast] Failed to send to chat=${link.telegramChatId}:`, error)
      failed++
    }

    // Rate limit: ~30 msg/sec → ~34ms between messages
    if (links.length > 1) {
      await new Promise((r) => setTimeout(r, 35))
    }
  }

  log.info(`[broadcast] Sent ${sent}/${links.length}, failed ${failed}`)
  return { sent, failed }
}
