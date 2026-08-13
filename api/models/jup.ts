/**
 * Jupiter Swap API v2 — /swap/v2/order response
 * https://developers.jup.ag/docs/swap/v2/order-and-execute.md
 */
export type SwapOrderResponse = {
  mode: 'ultra' | 'manual'
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold: string
  swapMode: string
  slippageBps: number
  inUsdValue?: number
  outUsdValue?: number
  priceImpact?: number
  swapUsdValue?: number
  priceImpactPct: string
  routePlan: Array<{
    swapInfo: {
      ammKey: string
      label: string
      inputMint: string
      outputMint: string
      inAmount: string
      outAmount: string
      feeAmount?: string
      feeMint?: string
    }
    percent: number
    bps: number
    usdValue?: number
  }>
  feeMint?: string
  feeBps: number
  signatureFeeLamports: number
  signatureFeePayer?: string | null
  prioritizationFeeLamports: number
  prioritizationFeePayer?: string | null
  rentFeeLamports: number
  rentFeePayer?: string | null
  swapType?: string
  router: 'iris' | 'jupiterz' | 'dflow' | 'okx'
  transaction: string | null
  gasless: boolean
  requestId: string
  totalTime: number
  taker: string | null
  quoteId?: string
  maker?: string
  expireAt?: string
  lastValidBlockHeight?: string
  platformFee?: { amount: string; feeBps: number; feeMint?: string }
  referralAccount?: string
  errorCode?: number
  errorMessage?: string
  error?: string
}

/**
 * Jupiter Swap API v2 — /swap/v2/execute response
 * https://developers.jup.ag/docs/swap/v2/order-and-execute.md
 */
export type SwapExecuteResponse = {
  status: 'Success' | 'Failed'
  code: number
  signature?: string
  slot?: string
  error?: string
  totalInputAmount?: string
  totalOutputAmount?: string
  inputAmountResult?: string
  outputAmountResult?: string
  swapEvents?: Array<{
    inputMint: string
    inputAmount: string
    outputMint: string
    outputAmount: string
  }>
}

/**
 * Retryable error codes from /swap/v2/execute.
 * Non-retryable codes: -2 (invalid signed tx), -3 (invalid message bytes),
 * -1002 (invalid tx), -1003 (not fully signed), -2002 (invalid payload).
 */
export const RETRYABLE_EXECUTE_CODES = new Set([-1, -1000, -1001, -1004, -2000, -2001, -2003, -2004])
