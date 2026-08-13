import {
  PublicKey,
  Transaction,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import type { Context } from 'hono'
import { createLighterClient } from '@paystream/perps/clients/lighter-client'
import { extractEmbeddedEthWallet, extractEmbeddedSolanaWallet } from '../../../utils/wallet'
import { createEmbeddedEthWallet, privy, getAuthorizationContext } from '../../../clients/privy'
import { connection } from '../../../clients/solana'
import { serializeTransactionForPrivy } from '../../../utils/transaction'
import { SOLANA_CAIP2, USDC_MINT, USDC_DECIMALS } from '../../../utils/constants'
import { log } from '../../../utils/log'
import { db } from '@paystream/db'
import { transfers } from '@paystream/db/schema'

/**
 * POST /api/arb/deposit/lighter
 * Deposit USDC to Lighter via Solana SPL transfer.
 * Gets an intent address (Solana token account) from Lighter API,
 * then transfers USDC directly to it.
 *
 * Request body:
 * {
 *   amount: number (e.g. 10 for $10 USDC)
 * }
 */
export async function lighterDepositHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const body = await c.req.json().catch(() => ({})) as { amount?: number }
    const { amount } = body

    if (!amount || amount <= 0) {
      return c.json({
        status: 'error',
        message: 'Amount must be a positive number (USDC)',
        error: 'Invalid amount',
      }, 400)
    }

    if (amount < 5) {
      return c.json({
        status: 'error',
        message: 'Minimum deposit is 5 USDC',
        error: 'Amount below minimum',
      }, 400)
    }

    // Need both wallets: ETH for Lighter account identity, Solana for sending USDC
    let embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedEthWallet) {
      try {
        embeddedEthWallet = await createEmbeddedEthWallet(authData.user.id)
      } catch (error) {
        log.error('[arb/deposit] Failed to create Ethereum wallet:', error)
        return c.json({
          status: 'error',
          message: 'Failed to create Ethereum wallet',
          error: error instanceof Error ? error.message : 'Unknown error',
        }, 500)
      }
    }

    const embeddedSolanaWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedSolanaWallet) {
      return c.json({
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Solana wallet required',
      }, 400)
    }

    // Get intent address from Lighter (a Solana token account)
    const client = createLighterClient()
    const intentResult = await client.createIntentAddress(embeddedEthWallet.address, amount)

    log.info(`[arb/deposit] Lighter intent address: ${intentResult.intent_address} for ${amount} USDC (eth=${embeddedEthWallet.address})`)

    // Build SPL USDC transfer to the intent address (already a token account)
    const walletPubkey = new PublicKey(embeddedSolanaWallet.address)
    const usdcMint = new PublicKey(USDC_MINT)
    const sourceAta = await getAssociatedTokenAddress(usdcMint, walletPubkey)
    const destTokenAccount = new PublicKey(intentResult.intent_address)
    const amountSmallest = Math.floor(amount * Math.pow(10, USDC_DECIMALS))

    const tx = new Transaction()
    tx.feePayer = walletPubkey
    tx.add(
      createTransferInstruction(
        sourceAta,
        destTokenAccount,
        walletPubkey,
        amountSmallest,
        [],
        TOKEN_PROGRAM_ID
      )
    )

    const { blockhash } = await connection.getLatestBlockhash('finalized')
    tx.recentBlockhash = blockhash

    const serializedTx = serializeTransactionForPrivy(tx)
    const authContext = getAuthorizationContext()

    const result = await privy.wallets().solana().signAndSendTransaction(
      embeddedSolanaWallet.walletId,
      {
        caip2: SOLANA_CAIP2,
        transaction: serializedTx,
        authorization_context: authContext,
      }
    )

    if (!result.hash) {
      throw new Error('Transaction hash not returned from Privy')
    }

    log.info(`[arb/deposit] Lighter deposit: ${amount} USDC, tx: ${result.hash}`)

    // Record transfer
    db.insert(transfers).values({
      privyUserId: authData.user.id,
      type: 'deposit',
      protocol: 'lighter',
      asset: 'USDC',
      amount,
      txHash: result.hash,
      fromAddress: embeddedSolanaWallet.address,
      toAddress: intentResult.intent_address,
      metadata: { ethAddress: embeddedEthWallet.address, intentAddress: intentResult.intent_address },
    }).catch(err => {
      log.error('[arb/deposit] Failed to record transfer:', err)
    })

    return c.json({
      status: 'success',
      message: `Deposited ${amount} USDC to Lighter`,
      txSignature: result.hash,
      amount,
      fromAddress: embeddedSolanaWallet.address,
      ethAddress: embeddedEthWallet.address,
      intentAddress: intentResult.intent_address,
    })
  } catch (error) {
    log.error('[arb/deposit] Lighter deposit error:', error)
    return c.json({
      status: 'error',
      message: 'Failed to execute Lighter deposit',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}

// ==================== Lighter Deposit Status ====================

/**
 * GET /api/arb/deposit/lighter/status
 * Get the latest deposit status for the user's Lighter account.
 * Proxies Lighter's /api/v1/deposit/latest endpoint.
 */
export async function lighterDepositStatusHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedEthWallet) {
      return c.json({
        status: 'error',
        message: 'No embedded Ethereum wallet found',
        error: 'Ethereum wallet required',
      }, 400)
    }

    const client = createLighterClient()
    const depositStatus = await client.getDepositLatest(embeddedEthWallet.address)

    return c.json(depositStatus)
  } catch (error) {
    log.error('[arb/deposit] Lighter deposit status error:', error)
    return c.json({
      status: 'error',
      message: 'Failed to fetch deposit status',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
