import { db } from '@paystream/db'
import { telegramUserLinks, telegramLinkTokens, telegramNotificationPreferences } from '@paystream/db/schema'
import { eq } from 'drizzle-orm'
import { log } from '../../utils/log.js'

/**
 * Verify a link token and link the Telegram chat to the Privy user.
 */
export async function verifyAndLink(
  token: string,
  telegramChatId: number,
  telegramUsername: string | undefined,
): Promise<{ success: boolean; walletAddress?: string; ethAddress?: string | null; error?: string }> {
  const [linkToken] = await db
    .select()
    .from(telegramLinkTokens)
    .where(eq(telegramLinkTokens.token, token))
    .limit(1)

  if (!linkToken) {
    return { success: false, error: 'Invalid token' }
  }

  if (linkToken.used) {
    return { success: false, error: 'Token already used' }
  }

  if (new Date() > linkToken.expiresAt) {
    return { success: false, error: 'Token expired' }
  }

  // Mark token as used
  await db
    .update(telegramLinkTokens)
    .set({ used: true })
    .where(eq(telegramLinkTokens.id, linkToken.id))

  // Upsert the user link
  await db
    .insert(telegramUserLinks)
    .values({
      privyUserId: linkToken.privyUserId,
      walletAddress: linkToken.walletAddress,
      ethAddress: linkToken.ethAddress,
      telegramChatId,
      telegramUsername: telegramUsername ?? null,
    })
    .onConflictDoUpdate({
      target: [telegramUserLinks.privyUserId],
      set: {
        telegramChatId,
        telegramUsername: telegramUsername ?? null,
        walletAddress: linkToken.walletAddress,
        ethAddress: linkToken.ethAddress,
        notificationsEnabled: true,
        updatedAt: new Date(),
      },
    })

  // Create default notification preferences (all enabled)
  const notificationTypes = [
    'liquidation_warning',
    'auto_close',
    'funding_flip',
    'position_movement',
    'size_drift',
    'close_error',
  ]

  for (const type of notificationTypes) {
    await db
      .insert(telegramNotificationPreferences)
      .values({
        privyUserId: linkToken.privyUserId,
        notificationType: type,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: [
          telegramNotificationPreferences.privyUserId,
          telegramNotificationPreferences.notificationType,
        ],
        set: {},
      })
  }

  log.success(`[user-link] Linked user=${linkToken.privyUserId} → chat=${telegramChatId}`)
  return { success: true, walletAddress: linkToken.walletAddress, ethAddress: linkToken.ethAddress }
}

/**
 * Unlink a Telegram chat from a Privy user.
 */
export async function unlinkUser(telegramChatId: number): Promise<boolean> {
  const [link] = await db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.telegramChatId, telegramChatId))
    .limit(1)

  if (!link) {
    return false
  }

  await db
    .delete(telegramNotificationPreferences)
    .where(eq(telegramNotificationPreferences.privyUserId, link.privyUserId))

  await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.id, link.id))

  log.info(`[user-link] Unlinked chat=${telegramChatId} (user=${link.privyUserId})`)
  return true
}
