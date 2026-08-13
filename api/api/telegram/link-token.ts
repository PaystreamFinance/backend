import type { Context } from 'hono'
import { db } from '@paystream/db'
import { telegramLinkTokens } from '@paystream/db/schema'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../utils/wallet'
import { log } from '../../utils/log'

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'PaystreamBot'
const TOKEN_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

/**
 * POST /api/telegram/link-token
 * Generates a short-lived token for linking Telegram to a Privy account.
 * Returns the token and a deep link URL.
 * Requires Privy auth.
 */
export async function linkTokenHandler(c: Context) {
  const authData = c.privyUser
  if (!authData) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const wallet = extractEmbeddedSolanaWallet(authData.user.linked_accounts || [])
  if (!wallet) {
    return c.json({ error: 'No embedded Solana wallet found' }, 400)
  }

  const ethWallet = extractEmbeddedEthWallet(authData.user.linked_accounts || [])

  const privyUserId = authData.user.id
  const walletAddress = wallet.address
  const ethAddress = ethWallet?.address ?? null

  // Generate crypto-random token
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32))
  const token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  await db.insert(telegramLinkTokens).values({
    token,
    privyUserId,
    walletAddress,
    ethAddress,
    expiresAt: new Date(Date.now() + TOKEN_EXPIRY_MS),
  })

  const deepLink = `https://t.me/${BOT_USERNAME}?start=${token}`

  log.info(`[telegram/link-token] Generated token for user=${privyUserId}`)

  return c.json({
    token,
    deepLink,
    expiresIn: TOKEN_EXPIRY_MS / 1000,
  })
}
