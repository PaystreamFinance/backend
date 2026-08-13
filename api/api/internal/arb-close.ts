import type { Context } from 'hono'
import { executeArbClose } from '../../services/arb-close-executor'
import { log } from '../../utils/log'

/**
 * POST /api/internal/arb/close
 * Internal endpoint for worker-triggered arb position closes.
 * Authenticated via x-service-key header (shared secret).
 */
export async function internalArbCloseHandler(c: Context) {
  try {
    const { pairId, market, protocols, privyUserId, closeReason, longProtocol, longSymbol, shortProtocol, shortSymbol } = await c.req.json()

    if (!privyUserId || !market || !protocols) {
      return c.json({ status: 'error', message: 'Missing required fields: privyUserId, market, protocols' }, 400)
    }

    const marketLabel = longSymbol && shortSymbol && longSymbol !== shortSymbol
      ? `${longSymbol}/${shortSymbol}`
      : market
    log.info(`[internal/arb-close] Closing pair=${pairId} market=${marketLabel} reason=${closeReason}`)

    const result = await executeArbClose({
      privyUserId,
      market,
      protocols,
      pairId,
      closeReason,
      longProtocol,
      longSymbol,
      shortProtocol,
      shortSymbol,
    })

    return c.json(result)
  } catch (error) {
    log.error('[internal/arb-close] Error:', error)
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
