import { SOL_WRAPPED_MINT, USDC_MINT, USDC_DECIMALS, USDT_MINT, USDT_DECIMALS, API_ENDPOINTS, JUPITER_API_KEY } from '../utils/constants'
import { getJupiterSwapQuote } from '../swap'
import { privy, getAuthorizationContext } from '../clients/privy'
import type { SwapExecuteResponse, SwapOrderResponse } from '../models'
import { RETRYABLE_EXECUTE_CODES } from '../models'
import { log } from '../utils/log'

// ── Token registry ─────────────────────────────────────────────────────────

export type SupportedToken = 'sol' | 'usdc' | 'usdt'

const TOKEN_CONFIG: Record<SupportedToken, { mint: string; decimals: number; label: string }> = {
  sol:  { mint: SOL_WRAPPED_MINT, decimals: 9,              label: 'SOL' },
  usdc: { mint: USDC_MINT,       decimals: USDC_DECIMALS,   label: 'USDC' },
  usdt: { mint: USDT_MINT,       decimals: USDT_DECIMALS,   label: 'USDT' },
}

export function getTokenConfig(token: SupportedToken) {
  return TOKEN_CONFIG[token]
}

export function isSupportedToken(token: string): token is SupportedToken {
  return token in TOKEN_CONFIG
}

// ── DEX deposit requirements ───────────────────────────────────────────────

export type DepositRequirement = {
  token: SupportedToken
  minimumAmount: number
}

const DEPOSIT_REQUIREMENTS: Record<string, DepositRequirement> = {
  hyperliquid: { token: 'sol',  minimumAmount: 0.12 },
  aster:       { token: 'usdt', minimumAmount: 1 },
}

export function getDepositRequirement(dex: string): DepositRequirement | null {
  return DEPOSIT_REQUIREMENTS[dex] ?? null
}

// ── Swap quote ─────────────────────────────────────────────────────────────

export type SwapQuote = {
  inputToken: SupportedToken
  inputAmount: number
  outputToken: SupportedToken
  outputAmount: number
  outputAmountRaw: string
  priceImpactPct: string
  quote: SwapOrderResponse
}

export async function getSwapQuote(
  inputToken: SupportedToken,
  outputToken: SupportedToken,
  amount: number,
  walletAddress: string,
): Promise<SwapQuote> {
  const input = TOKEN_CONFIG[inputToken]
  const output = TOKEN_CONFIG[outputToken]
  const inputAmountSmallest = Math.floor(amount * 10 ** input.decimals)

  const quote = await getJupiterSwapQuote({
    inputMint: input.mint,
    outputMint: output.mint,
    amount: inputAmountSmallest,
    taker: walletAddress,
    logPrefix: `[swap/${inputToken}→${outputToken}]`,
  })

  const outputAmount = parseInt(quote.outAmount, 10) / 10 ** output.decimals

  return {
    inputToken,
    inputAmount: amount,
    outputToken,
    outputAmount,
    outputAmountRaw: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
    quote,
  }
}

// ── Swap execution ─────────────────────────────────────────────────────────

export type SwapResult = {
  swapTxHash: string
  inputAmount: string
  outputAmount: string
  outputAmountHuman: number
  inputToken: SupportedToken
  outputToken: SupportedToken
}

export async function executeSwap(
  inputToken: SupportedToken,
  outputToken: SupportedToken,
  amount: number,
  walletId: string,
  walletAddress: string,
): Promise<SwapResult> {
  const input = TOKEN_CONFIG[inputToken]
  const output = TOKEN_CONFIG[outputToken]
  const prefix = `[swap/${inputToken}→${outputToken}]`

  const swapQuote = await getSwapQuote(inputToken, outputToken, amount, walletAddress)

  if (!swapQuote.quote.transaction) {
    throw new Error(swapQuote.quote.errorMessage || 'Jupiter did not return a swap transaction')
  }

  const authContext = getAuthorizationContext()
  const signed = await privy.wallets().solana().signTransaction(walletId, {
    transaction: swapQuote.quote.transaction,
    authorization_context: authContext,
  })

  if (!signed.signed_transaction) {
    throw new Error('Privy did not return a signed transaction')
  }

  const headers: HeadersInit = { 'Content-Type': 'application/json' }
  if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY

  const jupRes = await fetch(API_ENDPOINTS.JUP_SWAP_EXECUTE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      signedTransaction: signed.signed_transaction,
      requestId: swapQuote.quote.requestId,
    }),
  })

  if (!jupRes.ok) {
    const text = await jupRes.text().catch(() => '')
    log.error(`${prefix} Jupiter execute HTTP error:`, {
      status: jupRes.status,
      body: text.slice(0, 500),
      requestId: swapQuote.quote.requestId,
    })
    throw new Error(`Jupiter execute request failed: ${jupRes.status} ${jupRes.statusText}`)
  }

  const jupResult = (await jupRes.json()) as SwapExecuteResponse

  if (jupResult.status !== 'Success' || !jupResult.signature) {
    const retryable = RETRYABLE_EXECUTE_CODES.has(jupResult.code)
    log.error(`${prefix} Jupiter execute failed:`, {
      code: jupResult.code,
      error: jupResult.error,
      retryable,
      requestId: swapQuote.quote.requestId,
    })
    throw new Error(
      `Jupiter swap failed: ${jupResult.error || 'Unknown error'} (code: ${jupResult.code}, retryable: ${retryable})`,
    )
  }

  log.info(`${prefix} Swap executed: ${jupResult.signature}`)

  const events = jupResult.swapEvents
  const outputAmountRaw =
    jupResult.outputAmountResult ??
    jupResult.totalOutputAmount ??
    (events?.length ? events[events.length - 1]!.outputAmount : swapQuote.outputAmountRaw)

  const outputAmountHuman = parseInt(outputAmountRaw, 10) / 10 ** output.decimals

  return {
    swapTxHash: jupResult.signature,
    inputAmount:
      jupResult.inputAmountResult ??
      jupResult.totalInputAmount ??
      String(Math.floor(amount * 10 ** input.decimals)),
    outputAmount: outputAmountRaw,
    outputAmountHuman,
    inputToken,
    outputToken,
  }
}
