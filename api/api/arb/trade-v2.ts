import type { Context } from 'hono'
import type {
  ArbTradeV2Request,
  ArbTradeErrorResponse,
  ArbProtocol,
} from '../../models/arb'
import { isArbProtocol } from '../../models/arb'
import { executeArbTradeFlow } from './trade'

/**
 * POST /api/arb/trade/v2
 *
 * Like /api/arb/trade but takes distinct per-leg tickers so users can hedge
 * the same underlying asset across dexes that list it under different symbols
 * (e.g. long XAU on Pacifica + short GOLD on Hyperliquid, or long PAXG on
 * Aster + short XAU on Pacifica).
 *
 * The tickers must be whatever each dex uses natively (as returned by
 * /api/arb/markets in the per-dex columns). No cross-dex mapping is done
 * here — the frontend picks the tickers when the user selects the pair.
 */
export async function tradeV2Handler(c: Context) {
  const authData = c.privyUser
  if (!authData) {
    const response: ArbTradeErrorResponse = {
      status: 'error',
      message: 'User not authenticated',
      error: 'Authentication required',
    }
    return c.json(response, 401)
  }

  const body = await c.req.json().catch(() => ({})) as ArbTradeV2Request
  const { long, short, totalMarginUsd, leverage } = body
  const disableAclp = body.disableAclp === true
  const disableAutoclose = body.disableAutoclose === true

  if (!long?.ticker || !short?.ticker) {
    const response: ArbTradeErrorResponse = {
      status: 'error',
      message: 'Both long.ticker and short.ticker are required',
      error: 'Missing required field: ticker',
    }
    return c.json(response, 400)
  }

  if (!long?.dex || !short?.dex) {
    const response: ArbTradeErrorResponse = {
      status: 'error',
      message: 'Both long.dex and short.dex are required',
      error: 'Missing required field: dex',
    }
    return c.json(response, 400)
  }

  if (!isArbProtocol(long.dex) || !isArbProtocol(short.dex)) {
    const response: ArbTradeErrorResponse = {
      status: 'error',
      message: 'long.dex and short.dex must be valid arb protocol ids',
      error: 'Invalid dex',
    }
    return c.json(response, 400)
  }

  const logTag = long.ticker === short.ticker
    ? long.ticker
    : `${long.ticker}/${short.ticker}`

  return executeArbTradeFlow(c, {
    longMarket: long.ticker,
    shortMarket: short.ticker,
    longProtocol: long.dex as ArbProtocol,
    shortProtocol: short.dex as ArbProtocol,
    totalMarginUsd,
    leverage,
    disableAclp,
    disableAutoclose,
    logTag,
  })
}
