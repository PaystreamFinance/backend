import type { HyperliquidClient, HyperliquidSpotMeta } from '../clients/hyperliquid-client'
import { formatHyperliquidSize } from '../clients/hyperliquid-client'
import { log } from '../logger'

type SpotSwapParams = {
  /** Non-quote token to buy (`side: 'buy'`) or sell (`side: 'sell'`). */
  base: string
  side: 'buy' | 'sell'
  /**
   * For `buy`: USDC amount to spend (size is derived from the mid, minus a
   * slippage buffer). For `sell`: amount of `base` to sell directly.
   */
  amount: number
  /** Quote symbol (defaults to USDC — the only path we use today). */
  quote?: string
  /** Slippage buffer for buy sizing. Default 0.99 (1% buffer). */
  buySizeBuffer?: number
  /** IOC slippage % passed to placeSpotMarketOrder. Default 2. */
  slippagePct?: number
}

export type SpotSwapResult = {
  filledSize?: number
  avgPx?: number
}

/**
 * IOC market swap on Hyperliquid spot for the pair `<base>/<quote>` (quote
 * defaults to USDC). Assumes canonical pair layout where tokens[0] = base and
 * tokens[1] = quote — true for USDH, USDE, USDT, USOL vs USDC.
 */
export async function hlSpotSwap(
  hlClient: HyperliquidClient,
  spotMeta: HyperliquidSpotMeta,
  { base, side, amount, quote = 'USDC', buySizeBuffer = 0.99, slippagePct = 2 }: SpotSwapParams,
): Promise<SpotSwapResult> {
  const baseToken = spotMeta.tokens.find(t => t.name === base)
  if (!baseToken) throw new Error(`Spot token ${base} not in spotMeta`)
  const quoteToken = spotMeta.tokens.find(t => t.name === quote)
  if (!quoteToken) throw new Error(`Spot token ${quote} not in spotMeta`)

  const pair = spotMeta.universe.find(
    u => u.tokens[0] === baseToken.index && u.tokens[1] === quoteToken.index,
  )
  if (!pair) throw new Error(`No HL spot pair ${base}/${quote} found`)

  const allMids = await hlClient.getAllMids()
  const midKey = `@${pair.index}`
  const midPriceStr = allMids[midKey]
  if (!midPriceStr || midPriceStr === '0') {
    throw new Error(`No mid price for ${base}/${quote} (key ${midKey})`)
  }
  const midPrice = parseFloat(midPriceStr)

  const rawSize = side === 'buy' ? (amount * buySizeBuffer) / midPrice : amount
  const formattedSize = formatHyperliquidSize(rawSize, baseToken.szDecimals)
  if (formattedSize === '0' || parseFloat(formattedSize) === 0) {
    throw new Error(`${side} ${base}/${quote} size too small (raw=${rawSize})`)
  }

  log.info(`[hl-spot-swap] ${side} ${formattedSize} ${base} @ mid=${midPrice} (${quote})`)
  const result = await hlClient.placeSpotMarketOrder(
    pair.index,
    side === 'buy',
    formattedSize,
    midPrice,
    baseToken.szDecimals,
    slippagePct,
  )
  const status = result.response?.data?.statuses?.[0]
  if (status?.error) throw new Error(`${side} ${base}/${quote} failed: ${status.error}`)

  const filledSize = status?.filled?.totalSz ? parseFloat(status.filled.totalSz) : undefined
  const avgPx = status?.filled?.avgPx ? parseFloat(status.filled.avgPx) : undefined

  return {
    filledSize: Number.isFinite(filledSize) ? filledSize : undefined,
    avgPx: Number.isFinite(avgPx) ? avgPx : undefined,
  }
}
