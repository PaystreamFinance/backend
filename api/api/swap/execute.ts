import type { Context } from 'hono'
import { privy, getAuthorizationContext } from '../../clients/privy'
import { extractEmbeddedSolanaWallet } from '../../utils/wallet'
import { API_ENDPOINTS, JUPITER_API_KEY } from '../../utils/constants'
import { log } from '../../utils/log'
import { parsePrivyError } from '../../utils/error'
import { db } from '@paystream/db'
import { swaps } from '@paystream/db/schema'
import type { SwapExecuteResponse } from '../../models'
import { RETRYABLE_EXECUTE_CODES } from '../../models'
import { getRequestId } from './quote'

type ExecuteRequest = {
  transaction: string
}

type ExecuteResponse = {
  success: true
  transaction_hash: string
}

type ExecuteErrorResponse = {
  success: false
  error: string
  message?: string
  details?: string
  retryable?: boolean
}

export async function swapExecuteHandler(c: Context) {
  const authData = c.privyUser

  if (!authData) {
    const response: ExecuteErrorResponse = {
      success: false,
      error: 'Authentication required',
      message: 'User not authenticated',
    }
    return c.json(response, 401)
  }

  const body = (await c.req.json().catch(() => ({}))) as ExecuteRequest

  if (!body.transaction) {
    const response: ExecuteErrorResponse = {
      success: false,
      error: 'Missing required field',
      message: 'Missing required field',
      details: 'transaction is required',
    }
    return c.json(response, 400)
  }

  const requestId = getRequestId(authData.user.id)
  if (!requestId) {
    const response: ExecuteErrorResponse = {
      success: false,
      error: 'No quote found',
      message: 'No recent quote found. Please fetch a new quote before executing.',
      retryable: true,
    }
    return c.json(response, 400)
  }

  const embeddedWallet = extractEmbeddedSolanaWallet(
    authData.user.linked_accounts || []
  )

  if (!embeddedWallet) {
    const response: ExecuteErrorResponse = {
      success: false,
      error: 'Wallet not found',
      message: 'No embedded Solana wallet found',
      details: 'Embedded Solana wallet is required for transaction signing',
    }
    return c.json(response, 400)
  }

  const embeddedWalletId = embeddedWallet.walletId

  try {
    // Jupiter v2 transactions are immutable — modifying them invalidates the requestId.
    // Expired blockhash (~2 min TTL) returns error code -1; frontend re-quotes.
    const authContext = getAuthorizationContext()

    const signed = await privy
      .wallets()
      .solana()
      .signTransaction(embeddedWalletId, {
        transaction: body.transaction,
        authorization_context: authContext,
      })

    if (!signed.signed_transaction) {
      const response: ExecuteErrorResponse = {
        success: false,
        error: 'Signing failed',
        message: 'Swap execution failed: Privy did not return signed transaction',
      }
      return c.json(response, 500)
    }

    const headers: HeadersInit = { 'Content-Type': 'application/json' }
    if (JUPITER_API_KEY) {
      headers['x-api-key'] = JUPITER_API_KEY
    }

    const jupResponse = await fetch(API_ENDPOINTS.JUP_SWAP_EXECUTE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        signedTransaction: signed.signed_transaction,
        requestId,
      }),
    })

    const jupResult = (await jupResponse.json()) as SwapExecuteResponse

    if (jupResult.status !== 'Success' || !jupResult.signature) {
      const retryable = RETRYABLE_EXECUTE_CODES.has(jupResult.code)
      const response: ExecuteErrorResponse = {
        success: false,
        error: jupResult.error || 'Jupiter execute failed',
        message: `Swap execution failed: ${jupResult.error || 'Unknown error'}`,
        details: `code: ${jupResult.code}`,
        retryable,
      }
      return c.json(response, 500)
    }

    // Fire-and-forget DB insert — don't block the response
    const events = jupResult.swapEvents
    if (events && events.length > 0) {
      const inputMint = events[0]!.inputMint
      const outputMint = events[events.length - 1]!.outputMint

      db.insert(swaps)
        .values({
          privyUserId: authData.user.id,
          walletAddress: embeddedWallet.address,
          inputMint,
          outputMint,
          inAmount: jupResult.inputAmountResult ?? jupResult.totalInputAmount ?? events[0]!.inputAmount,
          outAmount: jupResult.outputAmountResult ?? jupResult.totalOutputAmount ?? events[events.length - 1]!.outputAmount,
          txHash: jupResult.signature,
        })
        .then(() => {
          log.info('[SWAP EXECUTE] Swap stored in DB', { txHash: jupResult.signature })
        })
        .catch((err) => {
          log.error('[SWAP EXECUTE] Failed to store swap in DB:', err)
        })
    }

    const successResponse: ExecuteResponse = {
      success: true,
      transaction_hash: jupResult.signature,
    }

    return c.json(successResponse)
  } catch (error) {
    log.error('SWAP EXECUTE - Error:', error)
    const parsedError = parsePrivyError(error)

    const errorResponse: ExecuteErrorResponse = {
      success: false,
      error: parsedError.error,
      message: parsedError.message,
      details: parsedError.details,
    }

    return c.json(errorResponse, 500)
  }
}
