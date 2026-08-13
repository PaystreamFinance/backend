import type { Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { getAuthData } from '../middleware/auth.js'
import { db } from '@paystream/db'
import { telegramNotificationPreferences } from '@paystream/db/schema'
import { eq, and } from 'drizzle-orm'
import { log } from '../../../utils/log.js'

const NOTIFICATION_LABELS: Record<string, string> = {
  liquidation_warning: 'Liquidation Warnings',
  auto_close: 'Auto-Close Events',
  funding_flip: 'Funding Rate Flips',
  position_movement: 'Position Movement',
  size_drift: 'Size Drift',
  close_error: 'Close Errors',
  better_opportunity: 'Better Opportunities',
}

export async function settingsCommand(ctx: Context) {
  const auth = getAuthData(ctx)
  if (!auth) return

  await sendSettingsKeyboard(ctx, auth.privyUserId)
}

async function buildKeyboard(privyUserId: string): Promise<InlineKeyboard> {
  const prefs = await db
    .select()
    .from(telegramNotificationPreferences)
    .where(eq(telegramNotificationPreferences.privyUserId, privyUserId))

  const prefMap = new Map(prefs.map((p) => [p.notificationType, p.enabled]))
  const keyboard = new InlineKeyboard()

  for (const [type, label] of Object.entries(NOTIFICATION_LABELS)) {
    const enabled = prefMap.get(type) ?? true
    const icon = enabled ? '\u2705' : '\u274c'
    keyboard.text(`${icon} ${label}`, `toggle:${type}`).row()
  }

  keyboard.text('\u2b05\ufe0f Back', 'settings:close').row()

  return keyboard
}

async function sendSettingsKeyboard(ctx: Context, privyUserId: string) {
  const keyboard = await buildKeyboard(privyUserId)

  await ctx.reply('<b>Notification Settings</b>\n\nTap to toggle notifications on/off:', {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  })
}

export async function handleSettingsCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data
  if (!data) return

  // Handle back/close button
  if (data === 'settings:close') {
    await ctx.answerCallbackQuery()
    await ctx.deleteMessage()
    return
  }

  if (!data.startsWith('toggle:')) return

  const auth = getAuthData(ctx)
  if (!auth) {
    await ctx.answerCallbackQuery({ text: 'Account not linked' })
    return
  }

  const notificationType = data.replace('toggle:', '')

  const [pref] = await db
    .select()
    .from(telegramNotificationPreferences)
    .where(
      and(
        eq(telegramNotificationPreferences.privyUserId, auth.privyUserId),
        eq(telegramNotificationPreferences.notificationType, notificationType),
      ),
    )
    .limit(1)

  const currentEnabled = pref?.enabled ?? true
  const newEnabled = !currentEnabled

  await db
    .insert(telegramNotificationPreferences)
    .values({
      privyUserId: auth.privyUserId,
      notificationType,
      enabled: newEnabled,
    })
    .onConflictDoUpdate({
      target: [
        telegramNotificationPreferences.privyUserId,
        telegramNotificationPreferences.notificationType,
      ],
      set: { enabled: newEnabled, updatedAt: new Date() },
    })

  const label = NOTIFICATION_LABELS[notificationType] ?? notificationType
  log.info(`[settings] ${auth.privyUserId} toggled ${notificationType} → ${newEnabled}`)

  await ctx.answerCallbackQuery({
    text: `${label}: ${newEnabled ? 'Enabled' : 'Disabled'}`,
  })

  const keyboard = await buildKeyboard(auth.privyUserId)
  await ctx.editMessageReplyMarkup({ reply_markup: keyboard })
}
