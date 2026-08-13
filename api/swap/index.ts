import BN from 'bn.js'
import type { SwapOrderResponse } from '../models'
import { API_ENDPOINTS, JUPITER_API_KEY } from '../utils/constants'
import { log } from '../utils/log'

export type { SwapOrderResponse }

export type GetJupiterSwapQuoteParams = {
  inputMint: string
  outputMint: string
  amount: string | number | BN
  taker?: string
  logPrefix?: string
}

/**
 * Fetches a Jupiter Swap v2 order (quote + unsigned transaction) for a token pair.
 * Passing `taker` includes a ready-to-sign transaction in the response.
 * Transactions have ~2 min TTL and are immutable after receipt.
 */
export async function getJupiterSwapQuote(
  params: GetJupiterSwapQuoteParams,
): Promise<SwapOrderResponse> {
  const {
    inputMint,
    outputMint,
    amount,
    taker,
    logPrefix = '[Jupiter]',
  } = params

  const query = new URLSearchParams()
  query.set('inputMint', inputMint)
  query.set('outputMint', outputMint)
  query.set('amount', amount instanceof BN ? amount.toString() : String(amount))
  if (taker) query.set('taker', taker)

  const url = `${API_ENDPOINTS.JUP_SWAP_ORDER_URL}?${query.toString()}`
  const headers: HeadersInit = {}
  if (JUPITER_API_KEY) {
    headers['x-api-key'] = JUPITER_API_KEY
  }

  log.info(`${logPrefix} Jupiter swap order request:`, {
    url,
    params: Object.fromEntries(query.entries()),
  })

  const res = await fetch(url, { method: 'GET', headers })

  if (res.status === 429) {
    log.error(`${logPrefix} Jupiter rate limited (429)`)
    throw new Error('Jupiter API rate limited. Please try again in a few seconds.')
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    log.error(`${logPrefix} Swap order error:`, text)
    let errorText = text

    try {
      const errorJson = JSON.parse(text)
      if (errorJson.error) {
        errorText = errorJson.error
      }
      log.error(`${logPrefix} getJupiterSwapQuote parsed error:`, errorJson)
    } catch {
      // Not JSON, use text as-is
    }

    if (
      errorText.includes('Failed to get quotes') ||
      errorText.includes('get quotes')
    ) {
      throw new Error('Swap quote failed: Unable to get quotes for this token pair')
    }

    throw new Error(
      `Jupiter swap order failed: ${res.status} ${res.statusText} ${errorText}`,
    )
  }

  const data = (await res.json()) as SwapOrderResponse
  return data
}
