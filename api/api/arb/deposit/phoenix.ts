import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import { createPhoenixArbProvider } from '@paystream/perps/providers/phoenix-provider'
import { extractEmbeddedSolanaWallet, getTokenBalance } from '../../../utils/wallet'
import { privy, getAuthorizationContext } from '../../../clients/privy'
import { connection } from '../../../clients/solana'
import { serializeTransactionForPrivy } from '../../../utils/transaction'
import { SOLANA_CAIP2, USDC_MINT, USDC_DECIMALS } from '../../../utils/constants'
import { log } from '../../../utils/log'
import { db } from '@paystream/db'
import { transfers } from '@paystream/db/schema'

const MIN_USDC_DEPOSIT = 1

/**
 * POST /api/arb/deposit/phoenix
 * Deposit USDC into the user's Phoenix collateral pool. The Rise SDK builds
 * the create-Phoenix-ATA + Ember-wrap + DepositFunds ix sequence; we sign
 * and submit via Privy.
 */
export async function phoenixDepositHandler(c: Context) {
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
      amount?: number
    }

    const asset = (body.asset?.toLowerCase() ?? 'usdc') as string
    const amount = body.amount

    if (asset !== 'usdc') {
      return c.json({
        status: 'error',
        message: 'Invalid asset. Phoenix deposits only support USDC.',
        error: 'Invalid asset',
      }, 400)
    }

    if (!amount || amount <= 0) {
      return c.json({
        status: 'error',
        message: 'Amount must be a positive number',
        error: 'Invalid amount',
      }, 400)
    }

    if (amount < MIN_USDC_DEPOSIT) {
      return c.json({
        status: 'error',
        message: `Minimum deposit is ${MIN_USDC_DEPOSIT} USDC`,
        error: 'Amount below minimum',
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

    const walletPubkey = new PublicKey(embeddedWallet.address)

    const usdcBalance = await getTokenBalance(
      connection, new PublicKey(USDC_MINT), walletPubkey, USDC_DECIMALS,
    ).then(b => b ?? 0)

    if (usdcBalance < amount) {
      return c.json({
        status: 'error',
        message: `Insufficient USDC balance. Wallet has ${usdcBalance.toFixed(2)} USDC, tried to deposit ${amount} USDC.`,
        error: 'Insufficient balance',
        walletBalance: usdcBalance,
      }, 400)
    }

    const provider = createPhoenixArbProvider({ walletPubkey })
    const [{ transaction }, { blockhash }] = await Promise.all([
      provider.buildDepositTransaction(amount, embeddedWallet.address),
      connection.getLatestBlockhash('finalized'),
    ])
    transaction.recentBlockhash = blockhash

    const serializedTx = serializeTransactionForPrivy(transaction)
    const authContext = getAuthorizationContext()

    log.info(`[arb/deposit] phoenix: depositing ${amount} USDC for ${embeddedWallet.address}`)
    const result = await privy.wallets().solana().signAndSendTransaction(
      embeddedWallet.walletId,
      {
        caip2: SOLANA_CAIP2,
        transaction: serializedTx,
        authorization_context: authContext,
      },
    )

    if (!result.hash) {
      throw new Error('Phoenix deposit transaction hash not returned from Privy')
    }
    log.info(`[arb/deposit] phoenix: tx=${result.hash}`)

    let recordingWarning: string | undefined
    try {
      await db.insert(transfers).values({
        privyUserId: authData.user.id,
        type: 'deposit',
        protocol: 'phoenix',
        asset: 'USDC',
        amount,
        txHash: result.hash,
        fromAddress: embeddedWallet.address,
        toAddress: null,
        metadata: { marginType: 'isolated' },
      })
    } catch (err) {
      log.error(`[arb/deposit] phoenix: Audit-log insert failed for user=${authData.user.id} tx=${result.hash}:`, err)
      recordingWarning = `Deposit submitted on-chain (tx=${result.hash}) but audit record failed. Contact support with the tx signature if the balance does not appear.`
    }

    return c.json({
      status: 'success',
      message: `Deposited ${amount} USDC to Phoenix`,
      txSignature: result.hash,
      asset: 'USDC',
      amount,
      fromAddress: embeddedWallet.address,
      note: 'Deposit will be credited to your Phoenix collateral once confirmed on-chain.',
      warning: recordingWarning,
    })
  } catch (error) {
    log.error('[arb/deposit] phoenix deposit error:', error)
    return c.json({
      status: 'error',
      message: 'Failed to execute Phoenix deposit',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
