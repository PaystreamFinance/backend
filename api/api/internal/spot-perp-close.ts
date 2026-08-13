import type { Context } from 'hono'
import { executeSpotPerpClose } from '../../services/spot-perp-close-executor'
import { log } from '../../utils/log'

/**
 * POST /api/internal/spot-perp/close
 * Internal endpoint for worker-triggered spot-perp position closes.
 * Authenticated via x-service-key header (shared secret).
 */
export async function internalSpotPerpCloseHandler(c: Context) {
  try {
    const { tradeId, market, spotTokenMint, perpProtocol, privyUserId, closeReason } = await c.req.json()

    if (!privyUserId || !tradeId || !market || !spotTokenMint || !perpProtocol) {
      return c.json({
        status: 'error',
        message: 'Missing required fields: privyUserId, tradeId, market, spotTokenMint, perpProtocol',
      }, 400)
    }

    log.info(`[internal/spot-perp-close] Closing trade=${tradeId} market=${market} reason=${closeReason}`)

    const result = await executeSpotPerpClose({
      privyUserId,
      tradeId,
      market,
      spotTokenMint,
      perpProtocol,
      closeReason,
    })

    return c.json(result)
  } catch (error) {
    log.error('[internal/spot-perp-close] Error:', error)
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
