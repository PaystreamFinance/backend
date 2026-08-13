import type { Context } from 'grammy'
import { db } from '@paystream/db'
import { telegramUserLinks } from '@paystream/db/schema'
import { eq } from 'drizzle-orm'
import { verifyAndLink } from '../../services/user-link.js'
import { log } from '../../../utils/log.js'

export async function startCommand(ctx: Context) {
  const payload = ctx.match as string | undefined
  const chatId = ctx.chat?.id

  if (!chatId) return

  // Check if already linked
  const [existingLink] = await db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.telegramChatId, chatId))
    .limit(1)

  // No token provided — show status
  if (!payload) {
    if (existingLink) {
      const lines = [
        'Welcome back to Paystream Bot!',
        '',
        'Your account is connected:',
        '',
        `Solana: \`${existingLink.walletAddress}\``,
      ]
      if (existingLink.ethAddress) {
        lines.push(`Ethereum: \`${existingLink.ethAddress}\``)
      }
      lines.push(
        '',
        'Use /positions to view your active trades.',
        'Use /settings to manage notifications.',
        'Use /help to see all commands.',
      )
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
    } else {
      await ctx.reply(
        'Welcome to Paystream Bot!\n\n' +
          'To link your account, use the "Connect Telegram" button in the Paystream app.\n\n' +
          'Once linked, you\'ll receive real-time notifications for your DeFi positions.\n\n' +
          'Use /help to see available commands.',
      )
    }
    return
  }

  // Deep link token provided
  const token = payload.trim()
  const username = ctx.from?.username

  log.info(`[start] Verifying link token for chat=${chatId} username=${username}`)

  const result = await verifyAndLink(token, chatId, username)

  if (!result.success) {
    await ctx.reply(`Link failed: ${result.error}\n\nPlease generate a new link from the Paystream app.`)
    return
  }

  const lines = [
    'Account linked successfully!',
    '',
    `Solana: \`${result.walletAddress}\``,
  ]
  if (result.ethAddress) {
    lines.push(`Ethereum: \`${result.ethAddress}\``)
  }
  lines.push(
    '',
    'You\'ll now receive notifications for:',
    '- Liquidation warnings',
    '- Auto-close events',
    '- Funding rate flips',
    '- Position size drift',
    '- Better opportunity alerts',
    '',
    'Use /settings to customize your notifications.',
    'Use /help to see all commands.',
  )

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}
