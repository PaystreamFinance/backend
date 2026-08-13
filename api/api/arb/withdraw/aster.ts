import type { Context } from 'hono'
import { extractEmbeddedSolanaWallet } from '../../../utils/wallet'
import { getAuthorizationContext } from '../../../clients/privy'
import { getOrCreateAsterApiCredentials } from '../../../clients/arb/aster-auth'
import { createAsterClient } from '@paystream/perps/clients/aster-client'
import { log } from '../../../utils/log'
import { db } from '@paystream/db'
import { transfers } from '@paystream/db/schema'

/**
 * POST /api/arb/withdraw/aster
 * Withdraw USDT from Aster perp account to user's Solana wallet
 *
 * Flow:
 * 1. Auth check + extract Solana wallet
 * 2. Get/create Aster API credentials
 * 3. Estimate withdraw fee
 * 4. Execute withdrawal
 */
export async function asterWithdrawHandler(c: Context) {
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
    log.info('[arb/withdraw/aster] Request:', JSON.stringify(body, null, 2))

    // Validate amount
    if (body.amount === undefined || body.amount === null) {
      return c.json({
        status: 'error',
        message: 'Missing required field',
        error: 'amount is required',
      }, 400)
    }

    const amount = typeof body.amount === 'string' ? parseFloat(body.amount) : body.amount
    if (isNaN(amount) || amount < 1) {
      return c.json({
        status: 'error',
        message: 'Invalid amount',
        error: 'amount must be at least 1 USDT',
      }, 400)
    }

    // Extract Solana wallet
    const embeddedSolanaWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )
    if (!embeddedSolanaWallet) {
      return c.json({
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Solana wallet required for receiving USDT',
      }, 400)
    }

    const userId = authData.user.id
    const solAddress = embeddedSolanaWallet.address
    const solWalletId = embeddedSolanaWallet.walletId
    const authContext = getAuthorizationContext()

    // Get or create Aster API credentials
    log.info(`[arb/withdraw/aster] Getting Aster credentials for ${userId}`)
    const creds = await getOrCreateAsterApiCredentials(userId, solAddress, solWalletId, authContext)

    // Create client and set credentials
    const client = createAsterClient()
    client.setApiCredentials(creds.apiKey, creds.apiSecret)

    // Estimate withdraw fee
    log.info(`[arb/withdraw/aster] Estimating withdraw fee for USDT`)
    const fee = await client.estimateWithdrawFee('USDT')
    log.info(`[arb/withdraw/aster] Fee estimate: gasCost=${fee.gasCost}, gasUsdValue=${fee.gasUsdValue}`)

    // Execute withdrawal
    log.info(`[arb/withdraw/aster] Withdrawing ${amount} USDT to ${solAddress}, fee=${fee.gasCost}`)
    const result = await client.withdraw(amount.toString(), fee.gasCost, solAddress)
    log.info(`[arb/withdraw/aster] Withdraw success: withdrawId=${result.withdrawId}, hash=${result.hash}`)

    // Record transfer
    db.insert(transfers).values({
      privyUserId: authData.user.id,
      type: 'withdrawal',
      protocol: 'aster',
      asset: 'USDT',
      amount,
      txHash: result.hash,
      toAddress: solAddress,
      metadata: { withdrawId: result.withdrawId, fee: { gasCost: fee.gasCost, gasUsdValue: fee.gasUsdValue } },
    }).catch(err => {
      log.error('[arb/withdraw/aster] Failed to record transfer:', err)
    })

    return c.json({
      status: 'success',
      message: `Withdrawal of ${amount} USDT initiated`,
      data: {
        amount,
        withdrawId: result.withdrawId,
        hash: result.hash,
        receiver: solAddress,
        fee: {
          gasCost: fee.gasCost,
          gasUsdValue: fee.gasUsdValue,
        },
      },
    })
  } catch (error) {
    log.error('[arb/withdraw/aster] Error:', error instanceof Error ? error.message : error)
    if (error instanceof Error && error.stack) {
      log.error('[arb/withdraw/aster] Stack:', error.stack)
    }

    return c.json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Withdrawal failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
