import { Bot } from 'grammy'
import { log } from '../../utils/log.js'
import { authMiddleware } from './middleware/auth.js'
import { startCommand } from './commands/start.js'
import { portfolioCommand } from './commands/portfolio.js'
import { fundingCommand } from './commands/funding.js'
import { positionsCommand } from './commands/positions.js'
import { settingsCommand, handleSettingsCallback } from './commands/settings.js'
import { unlinkCommand } from './commands/unlink.js'
import { helpCommand } from './commands/help.js'

export function createBot(token: string): Bot {
  const bot = new Bot(token)

  // /start does its own auth (deep link flow + status check)
  bot.command('start', startCommand)

  // /unlink doesn't need auth middleware (checks DB directly)
  bot.command('unlink', unlinkCommand)

  // /help is public
  bot.command('help', helpCommand)

  // All other commands require linked account
  bot.command('portfolio', authMiddleware, portfolioCommand)
  bot.command('funding', authMiddleware, fundingCommand)
  bot.command('positions', authMiddleware, positionsCommand)
  bot.command('settings', authMiddleware, settingsCommand)

  // Callback query handler for settings inline keyboard
  bot.on('callback_query:data', authMiddleware, handleSettingsCallback)

  // Error handler
  bot.catch((err) => {
    log.error('[bot] Error:', err.error)
  })

  log.info('[bot] Commands registered')
  return bot
}

export async function startBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    log.warn('[bot] TELEGRAM_BOT_TOKEN not set, skipping bot startup')
    return
  }

  const { setBotInstance } = await import('../services/notifications.js')
  const bot = createBot(token)
  setBotInstance(bot)

  bot.start({
    onStart: () => {
      log.info('[bot] Telegram bot started polling')
    },
  })
}
