import type { Context } from 'hono'
import { isArbProtocol } from '../../models/arb'
import { executeArbSetTpSl } from '../../services/arb-set-tp-sl-executor'
import { log } from '../../utils/log'

/**
 * POST /api/internal/arb/set-stop-loss
 * Internal endpoint for worker-triggered stop-loss placement.
 * Used by the ride-to-liquidation flow when one leg has been liquidated
 * and we need to set a tight SL on the surviving leg.
 * Authenticated via x-service-key header (shared secret).
 */
export async function internalArbSetStopLossHandler(c: Context) {
  try {
    const { pairId, market, protocol, stopPrice, privyUserId } = await c.req.json()

    if (!privyUserId || !market || !protocol || typeof stopPrice !== 'number' || stopPrice <= 0) {
      return c.json({
        status: 'error',
        message: 'Missing or invalid fields: privyUserId, market, protocol, stopPrice',
      }, 400)
    }

    if (!isArbProtocol(protocol)) {
      return c.json({ status: 'error', message: `Invalid protocol: ${protocol}` }, 400)
    }

    log.info(`[internal/arb-set-sl] pair=${pairId} ${protocol}/${market} stopPrice=$${stopPrice}`)

    const result = await executeArbSetTpSl({
      privyUserId,
      market,
      protocol,
      type: 'sl',
      triggerPrice: stopPrice,
    })

    return c.json(result)
  } catch (error) {
    log.error('[internal/arb-set-sl] Error:', error)
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
