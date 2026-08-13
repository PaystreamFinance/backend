import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import { createPhoenixArbProvider } from '@paystream/perps/providers/phoenix-provider'
import { extractEmbeddedSolanaWallet } from '../../../utils/wallet'
import { privy, getAuthorizationContext } from '../../../clients/privy'
import { connection } from '../../../clients/solana'
import { serializeTransactionForPrivy } from '../../../utils/transaction'
import { SOLANA_CAIP2 } from '../../../utils/constants'
import { log } from '../../../utils/log'
import { db } from '@paystream/db'
import { transfers } from '@paystream/db/schema'

const MIN_USDC_WITHDRAW = 1

/** Per-user mutex to guard against double-submit on client retry. */
const inflightWithdraws = new Set<string>()

/**
 * POST /api/arb/withdraw/phoenix
 * Withdraw USDC from the user's Phoenix collateral pool back to their
 * Solana USDC ATA. Phoenix's withdraw ix enqueues into an on-chain
 * `WithdrawQueue`; the actual SPL transfer happens once the queue
 * processes the entry, so the user-visible balance lags the tx
 * confirmation. We persist the transfer row in `initiated` state and let
 * the user poll /transfers / their wallet balance.
 */
export async function phoenixWithdrawHandler(c: Context) {
  try {
    const authData = c.privyUser
    if (!authData) {
      return c.json({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      asset?: string
      amount?: number | string
    }
    log.info('[arb/withdraw/phoenix] Request:', JSON.stringify(body))

    const asset = (body.asset?.toLowerCase() ?? 'usdc') as string
    if (asset !== 'usdc') {
      return c.json({
        status: 'error',
        message: 'Invalid asset. Phoenix withdrawals only support USDC.',
        error: 'Invalid asset',
      }, 400)
    }

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
      const walletPubkey = new PublicKey(embeddedWallet.address)
      const provider = createPhoenixArbProvider({ walletPubkey })
      const [{ transaction }, { blockhash }] = await Promise.all([
        provider.buildWithdrawTransaction(amount, embeddedWallet.address),
        connection.getLatestBlockhash('finalized'),
      ])
      transaction.recentBlockhash = blockhash

      const serializedTx = serializeTransactionForPrivy(transaction)
      const authContext = getAuthorizationContext()

      log.info(`[arb/withdraw/phoenix] withdrawing ${amount} USDC to ${embeddedWallet.address}`)
      const result = await privy.wallets().solana().signAndSendTransaction(
        embeddedWallet.walletId,
        {
          caip2: SOLANA_CAIP2,
          transaction: serializedTx,
          authorization_context: authContext,
        },
      )

      if (!result.hash) {
        throw new Error('Phoenix withdraw transaction hash not returned from Privy')
      }
      log.info(`[arb/withdraw/phoenix] tx=${result.hash}`)

      // Phoenix's withdraw goes through an on-chain queue: the tx confirms
      // immediately, but funds settle to the SPL ATA when the queue processes
      // the entry. Surface the queued state to the client.
      let recordingWarning: string | undefined
      try {
        await db.insert(transfers).values({
          privyUserId: authData.user.id,
          type: 'withdrawal',
          protocol: 'phoenix',
          asset: 'USDC',
          amount,
          txHash: result.hash,
          toAddress: embeddedWallet.address,
          metadata: { marginType: 'isolated', queued: true },
        })
      } catch (err) {
        log.error(`[arb/withdraw/phoenix] Audit-log insert failed for user=${authData.user.id} tx=${result.hash}:`, err)
        recordingWarning = `Withdrawal submitted on-chain (tx=${result.hash}) but audit record failed. Contact support with the tx signature if the balance does not appear.`
      }

      return c.json({
        status: 'success',
        message: `Withdrawal of ${amount} USDC enqueued`,
        data: {
          amount,
          txHash: result.hash,
          receiver: embeddedWallet.address,
          queued: true,
        },
        note: 'Phoenix processes withdrawals through an on-chain queue. Funds will arrive in your Solana USDC account once the queue settles your entry.',
        warning: recordingWarning,
      })
    } finally {
      inflightWithdraws.delete(authData.user.id)
    }
  } catch (error) {
    log.error('[arb/withdraw/phoenix] Error:', error instanceof Error ? error.message : error)
    return c.json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Withdrawal failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
