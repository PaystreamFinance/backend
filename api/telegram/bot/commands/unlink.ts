import type { Context } from 'grammy'
import { unlinkUser } from '../../services/user-link.js'

export async function unlinkCommand(ctx: Context) {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const unlinked = await unlinkUser(chatId)

  if (!unlinked) {
    await ctx.reply('Your Telegram is not linked to any Paystream account.')
    return
  }

  await ctx.reply(
    'Your Telegram has been disconnected from Paystream.\n\n' +
      'You will no longer receive notifications.\n' +
      'Use the Paystream app to re-link anytime.',
  )
}
