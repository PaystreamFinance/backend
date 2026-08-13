import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import { buildPacificaDepositTransaction } from '../../clients/arb/pacifica-deposit'
import { extractEmbeddedSolanaWallet } from '../../utils/wallet'
import { privy, getAuthorizationContext } from '../../clients/privy'
import { SOLANA_CAIP2 } from '../../utils/constants'
import { serializeTransactionForPrivy } from '../../utils/transaction'
import { parsePrivyError } from '../../utils/error'
import { log } from '../../utils/log'
import { db } from '@paystream/db'
import { transfers } from '@paystream/db/schema'

export interface PacificaDepositRequest {
  amount: number | string // Amount in USDC
}

export interface PacificaDepositSuccessResponse {
  status: 'success'
  message: string
  data: {
    txn_hash: string
    amount: string
  }
}

export interface PacificaDepositErrorResponse {
  status: 'error'
  message: string
  error: string
  details?: string
}

/**
 * POST /api/pacifica/deposit
 * Deposit USDC to Pacifica trading account
 */
export async function depositHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      const response: PacificaDepositErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const body = (await c.req.json().catch(() => ({}))) as PacificaDepositRequest
    log.info('[pacifica/deposit] Request:', JSON.stringify(body, null, 2))

    // Validate request
    if (body.amount === undefined || body.amount === null) {
      const response: PacificaDepositErrorResponse = {
        status: 'error',
        message: 'Missing required field',
        error: 'Missing required field',
        details: 'amount is required',
      }
      return c.json(response, 400)
    }

    const amount = typeof body.amount === 'string' ? parseFloat(body.amount) : body.amount
    if (isNaN(amount) || amount <= 0) {
      const response: PacificaDepositErrorResponse = {
        status: 'error',
        message: 'Invalid amount',
        error: 'Invalid amount',
        details: 'amount must be a positive number',
      }
      return c.json(response, 400)
    }

    // Minimum deposit is 10 USDC on Pacifica
    if (amount < 10) {
      const response: PacificaDepositErrorResponse = {
        status: 'error',
        message: 'Amount too small',
        error: 'Minimum deposit is 10 USDC',
        details: 'Pacifica requires a minimum deposit of 10 USDC',
      }
      return c.json(response, 400)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedWallet) {
      const response: PacificaDepositErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
        details: 'Embedded Solana wallet is required for transaction signing',
      }
      return c.json(response, 400)
    }

    const walletAddress = embeddedWallet.address
    const walletPubkey = new PublicKey(walletAddress)
    const embeddedWalletId = embeddedWallet.walletId

    const authContext = getAuthorizationContext()

    log.info(`[pacifica/deposit] Building deposit transaction for ${amount} USDC`)

    // Build the deposit transaction
    const depositResult = await buildPacificaDepositTransaction(walletPubkey, amount)

    // Serialize for Privy
    const serializedTx = serializeTransactionForPrivy(depositResult.transaction)

    log.info('[pacifica/deposit] Sending deposit transaction...')
    const sent = await privy
      .wallets()
      .solana()
      .signAndSendTransaction(embeddedWalletId, {
        caip2: SOLANA_CAIP2,
        transaction: serializedTx,
        authorization_context: authContext,
      })

    if (!sent.hash) {
      const response: PacificaDepositErrorResponse = {
        status: 'error',
        message: 'Deposit transaction failed: Transaction ID not returned from Privy',
        error: 'Transaction ID not returned from Privy',
      }
      return c.json(response, 500)
    }

    log.info('[pacifica/deposit] Deposit transaction sent:', sent.hash)

    // Record transfer
    db.insert(transfers).values({
      privyUserId: authData.user.id,
      type: 'deposit',
      protocol: 'pacifica',
      asset: 'USDC',
      amount,
      txHash: sent.hash,
      fromAddress: walletAddress,
      toAddress: depositResult.vaultAddress,
    }).catch(err => {
      log.error('[pacifica/deposit] Failed to record transfer:', err)
    })

    // Referral code claim is handled at trade time (executePacificaOrder) instead of here,
    // because Pacifica may not have indexed the deposit by the time this returns.

    const response: PacificaDepositSuccessResponse = {
      status: 'success',
      message: 'Deposit successful',
      data: {
        txn_hash: sent.hash,
        amount: amount.toString(),
      },
    }

    return c.json(response)
  } catch (error) {
    log.error('[pacifica/deposit] Error:', error instanceof Error ? error.message : error)
    if (error instanceof Error && error.stack) {
      log.error('[pacifica/deposit] Stack:', error.stack)
    }

    const parsedError = parsePrivyError(error)

    const errorResponse: PacificaDepositErrorResponse = {
      status: 'error',
      message: parsedError.message,
      error: parsedError.error,
      details: parsedError.details,
    }
    return c.json(errorResponse, 500)
  }
}
