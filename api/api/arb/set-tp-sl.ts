import type { Context } from 'hono'
import type {
  ArbSetTpSlRequest,
  ArbSetTpSlSuccessResponse,
  ArbSetTpSlErrorResponse,
  TpSlResult,
  TpSlTarget,
} from '../../models/arb'
import { isArbProtocol, TP_SL_TYPES } from '../../models/arb'
import { extractEmbeddedSolanaWallet } from '../../utils/wallet'
import { executeArbSetTpSl } from '../../services/arb-set-tp-sl-executor'
import { log } from '../../utils/log'

function validateTarget(target: TpSlTarget): string | null {
  if (!isArbProtocol(target.protocol)) {
    return `Invalid protocol: ${target.protocol}`
  }
  if (!TP_SL_TYPES.includes(target.type)) {
    return `Invalid type: ${target.type} (expected 'tp' or 'sl')`
  }
  if (!target.market) {
    return `Missing market for ${target.protocol}`
  }
  const hasPrice = typeof target.triggerPrice === 'number'
  const hasPercent = typeof target.triggerPricePercent === 'number'
  if (hasPrice === hasPercent) {
    return `Exactly one of triggerPrice or triggerPricePercent must be provided for ${target.protocol}/${target.market}`
  }
  if (hasPrice && (target.triggerPrice as number) <= 0) {
    return `Invalid triggerPrice for ${target.protocol}/${target.market}`
  }
  if (hasPercent) {
    const pct = target.triggerPricePercent as number
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      return `triggerPricePercent must be between 0 and 100 (exclusive) for ${target.protocol}/${target.market}`
    }
  }
  return null
}

/**
 * POST /api/arb/set-tp-sl
 * Set a take-profit or stop-loss on existing positions across exchanges.
 * Each entry sets either TP or SL (one type per item).
 *
 * Shares per-protocol execution logic with the internal worker endpoint
 * via `executeArbSetTpSl`.
 */
export async function setTpSlHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      const response: ArbSetTpSlErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )
    if (!embeddedWallet) {
      const response: ArbSetTpSlErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
      }
      return c.json(response, 400)
    }

    const body = await c.req.json().catch(() => ({})) as ArbSetTpSlRequest

    if (!body.positions || !Array.isArray(body.positions) || body.positions.length === 0) {
      const response: ArbSetTpSlErrorResponse = {
        status: 'error',
        message: 'positions array is required',
        error: 'Missing required field: positions',
      }
      return c.json(response, 400)
    }

    for (const target of body.positions) {
      const err = validateTarget(target)
      if (err) {
        const response: ArbSetTpSlErrorResponse = { status: 'error', message: err }
        return c.json(response, 400)
      }
    }

    const results: TpSlResult[] = await Promise.all(
      body.positions.map(async (target): Promise<TpSlResult> => {
        try {
          const execResult = await executeArbSetTpSl({
            privyUserId: authData.user.id,
            market: target.market,
            protocol: target.protocol,
            type: target.type,
            triggerPrice: target.triggerPrice,
            triggerPricePercent: target.triggerPricePercent,
          })

          return {
            protocol: target.protocol,
            market: target.market,
            type: target.type,
            triggerPrice: execResult.triggerPrice ?? target.triggerPrice ?? 0,
            triggerPricePercent: target.triggerPricePercent,
            entryPrice: execResult.entryPrice,
            status: execResult.success ? 'success' : 'error',
            direction: execResult.direction,
            error: execResult.success ? undefined : (execResult.error || 'Unknown error'),
          }
        } catch (error) {
          log.error(`[arb/set-tp-sl] Failed for ${target.type} ${target.protocol}/${target.market}:`, error)
          return {
            protocol: target.protocol,
            market: target.market,
            type: target.type,
            triggerPrice: target.triggerPrice ?? 0,
            triggerPricePercent: target.triggerPricePercent,
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
          }
        }
      }),
    )

    const successCount = results.filter(r => r.status === 'success').length
    const allSuccess = successCount === results.length
    const anySuccess = successCount > 0

    if (!anySuccess) {
      const response: ArbSetTpSlErrorResponse & { results: TpSlResult[] } = {
        status: 'error',
        message: 'Failed to set TP/SL on all positions',
        results,
      }
      return c.json(response, 400)
    }

    const response: ArbSetTpSlSuccessResponse = {
      status: allSuccess ? 'success' : 'partial',
      message: allSuccess
        ? `TP/SL set on ${results.length} position(s)`
        : `TP/SL set on ${successCount}/${results.length} position(s)`,
      results,
    }

    return c.json(response)
  } catch (error) {
    log.error('[arb/set-tp-sl] Error:', error instanceof Error ? error.message : error)

    const response: ArbSetTpSlErrorResponse = {
      status: 'error',
      message: error instanceof Error ? error.message : 'Failed to set TP/SL',
    }
    return c.json(response, 500)
  }
}
