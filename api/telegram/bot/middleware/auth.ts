import type { Context, NextFunction } from 'grammy'
import { db } from '@paystream/db'
import { telegramUserLinks } from '@paystream/db/schema'
import { eq } from 'drizzle-orm'

export interface AuthContext {
  privyUserId: string
  walletAddress: string
  ethAddress: string | null
}

/**
 * Bot middleware that resolves telegram_chat_id → privy_user_id.
 * Sets ctx.authData if the user is linked, otherwise replies with an error.
 */
export async function authMiddleware(ctx: Context, next: NextFunction) {
  const chatId = ctx.chat?.id
  if (!chatId) {
    await next()
    return
  }

  const [link] = await db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.telegramChatId, chatId))
    .limit(1)

  if (!link) {
    await ctx.reply(
      'Your Telegram is not linked to a Paystream account.\n\n' +
        'Use the "Connect Telegram" button in the Paystream app to link your account.',
    )
    return
  }

  ;(ctx as Context & { authData: AuthContext }).authData = {
    privyUserId: link.privyUserId,
    walletAddress: link.walletAddress,
    ethAddress: link.ethAddress,
  }

  await next()
}

/**
 * Helper to extract authData from context. Returns null if not linked.
 */
export function getAuthData(ctx: Context): AuthContext | null {
  return (ctx as Context & { authData?: AuthContext }).authData ?? null
}
