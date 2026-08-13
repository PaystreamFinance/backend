import type { Context } from 'grammy'

export async function helpCommand(ctx: Context) {
  await ctx.reply(
    '<b>Paystream Bot Commands</b>\n\n' +
      '/portfolio \u2014 Active positions summary\n' +
      '/positions \u2014 Current active hedged trades\n' +
      '/funding [symbol] \u2014 Current funding rates\n' +
      '/settings \u2014 Notification settings\n' +
      '/unlink \u2014 Disconnect Telegram from Paystream\n' +
      '/help \u2014 See all available commands\n\n' +
      'To link your account, use the "Connect Telegram" button in the Paystream app.',
    { parse_mode: 'HTML' },
  )
}
