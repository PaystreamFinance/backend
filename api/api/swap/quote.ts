import type { Context } from 'hono'
import { extractEmbeddedSolanaWallet } from '../../utils/wallet'
import { log } from '../../utils/log'
import { parsePrivyError } from '../../utils/error'
import { getJupiterSwapQuote } from '../../swap'
import type { SwapOrderResponse } from '../../models'
import { cache } from '../../utils/cache'

const REQUEST_ID_CACHE_PREFIX = 'swap-request-id:'
const REQUEST_ID_TTL_MS = 5 * 60 * 1000

export function getRequestId(privyUserId: string): string | null {
  return cache.get<string>(REQUEST_ID_CACHE_PREFIX + privyUserId)
}

type QuoteResponse = {
  status: 'success'
  data: SwapOrderResponse
}

type QuoteErrorResponse = {
  status: 'error'
  message: string
  error: string
  details?: string
}

export async function swapQuoteHandler(c: Context) {
  const authData = c.privyUser

  if (!authData) {
    const response: QuoteErrorResponse = {
      status: 'error',
      message: 'User not authenticated',
      error: 'Authentication required',
    }
    return c.json(response, 401)
  }

  const inputMint = c.req.query('inputMint')
  const outputMint = c.req.query('outputMint')
  const amount = c.req.query('amount')

  log.info('[SWAP QUOTE] Frontend request params:', {
    inputMint,
    outputMint,
    amount,
  })

  if (!inputMint || !outputMint || !amount) {
    const response: QuoteErrorResponse = {
      status: 'error',
      message: 'Missing required query parameters',
      error: 'Missing required fields',
      details: 'inputMint, outputMint, and amount are required',
    }
    return c.json(response, 400)
  }

  const embeddedWallet = extractEmbeddedSolanaWallet(
    authData.user.linked_accounts || []
  )

  if (!embeddedWallet) {
    const response: QuoteErrorResponse = {
      status: 'error',
      message: 'No embedded Solana wallet found',
      error: 'Wallet not found',
      details: 'Embedded Solana wallet is required',
    }
    return c.json(response, 400)
  }

  const walletAddress = embeddedWallet.address

  try {
    // Get quote and transaction from Jupiter Ultra API
    const orderData = await getJupiterSwapQuote({
      inputMint,
      outputMint,
      amount,
      taker: walletAddress,
      logPrefix: '[SWAP QUOTE]',
    })

    // Store requestId for the execute handler to use with Jupiter Ultra execute
    if (orderData.requestId) {
      cache.set(REQUEST_ID_CACHE_PREFIX + authData.user.id, orderData.requestId, REQUEST_ID_TTL_MS)
    }

    const response: QuoteResponse = {
      status: 'success',
      data: orderData,
    }

    return c.json(response)
  } catch (error) {
    log.error('[SWAP QUOTE] Error:', error)
    const parsedError = parsePrivyError(error)

    const errorResponse: QuoteErrorResponse = {
      status: 'error',
      message: parsedError.message,
      error: parsedError.error,
      details: parsedError.details,
    }

    return c.json(errorResponse, 500)
  }
}

