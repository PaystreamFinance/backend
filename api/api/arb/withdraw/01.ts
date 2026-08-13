import type { Context } from 'hono'
import { extractEmbeddedSolanaWallet } from '../../../utils/wallet'
import { getAuthorizationContext } from '../../../clients/privy'
import { createZoNordUserForWithdraw } from '../../../clients/arb/zo-sdk'
import { runWithZoSessionInvalidation } from '../../../clients/arb/zo-auth'
import { formatZoErrorResponse } from '../../../clients/arb/zo-errors'
import { log } from '../../../utils/log'
import { db } from '@paystream/db'
import { transfers } from '@paystream/db/schema'

/** Per-user mutex — prevents accidental double-submit from client retry. */
const inflightWithdraws = new Set<string>()

const ZO_USDC_TOKEN_ID = 0
const MIN_USDC_WITHDRAW = 1

/**
 * POST /api/arb/withdraw/01
 * Withdraw USDC from the user's 01 account back to their Solana wallet. The
 * withdrawal is session-signed (no Privy round-trip while a session is alive).
 */
export async function zoWithdrawHandler(c: Context) {
  try {
    const authData = c.privyUser
    if (!authData) {
      return c.json({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const body = (await c.req.json().catch(() => ({}))) as { amount?: number | string }
    log.info('[arb/withdraw/01] Request:', JSON.stringify(body))

    if (body.amount === undefined || body.amount === null) {
      return c.json({
        status: 'error',
        message: 'Missing required field',
        error: 'amount is required',
      }, 400)
    }

    const amount = typeof body.amount === 'string' ? parseFloat(body.amount) : body.amount
    if (isNaN(amount) || amount < MIN_USDC_WITHDRAW) {
      return c.json({
        status: 'error',
        message: 'Invalid amount',
        error: `amount must be at least ${MIN_USDC_WITHDRAW} USDC`,
      }, 400)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(authData.user.linked_accounts || [])
    if (!embeddedWallet) {
      return c.json({
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Solana wallet required',
      }, 400)
    }

    if (inflightWithdraws.has(authData.user.id)) {
      return c.json({
        status: 'error',
        message: 'Another withdrawal is already in progress for this account. Please wait for it to complete.',
        error: 'Withdrawal already in progress',
      }, 409)
    }
    inflightWithdraws.add(authData.user.id)

    try {
      const authContext = getAuthorizationContext()
      const nordUser = await createZoNordUserForWithdraw({
        privyUserId: authData.user.id,
        embeddedWallet,
        authContext,
      })

      log.info(`[arb/withdraw/01] withdrawing ${amount} USDC to ${embeddedWallet.address}`)
      const { actionId } = await runWithZoSessionInvalidation(authData.user.id, () => nordUser.withdraw({
        amount,
        tokenId: ZO_USDC_TOKEN_ID,
      }))
      const actionIdStr = actionId.toString()
      log.info(`[arb/withdraw/01] submitted actionId=${actionIdStr}`)

      // Block on the audit-log insert. If this fails we've already submitted the
      // withdrawal to Nord and can't roll it back — surface the actionId loudly
      // so ops can reconcile, and warn the user in the response.
      let recordingWarning: string | undefined
      try {
        await db.insert(transfers).values({
          privyUserId: authData.user.id,
          type: 'withdrawal',
          protocol: '01',
          asset: 'USDC',
          amount,
          txHash: null,
          toAddress: embeddedWallet.address,
          metadata: { actionId: actionIdStr },
        })
      } catch (err) {
        log.error(`[arb/withdraw/01] Audit-log insert failed for user=${authData.user.id} actionId=${actionIdStr} amount=${amount}:`, err)
        recordingWarning = `Withdrawal submitted to 01 (actionId=${actionIdStr}) but audit record failed. Contact support with the actionId if the balance does not update.`
      }

      return c.json({
        status: 'success',
        message: `Withdrawal of ${amount} USDC initiated`,
        data: {
          amount,
          actionId: actionIdStr,
          receiver: embeddedWallet.address,
        },
        warning: recordingWarning,
      })
    } finally {
      inflightWithdraws.delete(authData.user.id)
    }
  } catch (error) {
    log.error('[arb/withdraw/01] Error:', error instanceof Error ? error.message : error)
    const { body, status } = formatZoErrorResponse(error, 'Withdrawal failed')
    return c.json(body, status as 400 | 401 | 500 | 503)
  }
}
