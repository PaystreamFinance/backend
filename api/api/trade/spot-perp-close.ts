import type { Context } from 'hono'
import type {
  SpotPerpCloseRequest,
  SpotPerpCloseSuccessResponse,
  SpotPerpCloseErrorResponse,
} from '../../models/spot-perp'
import { extractEmbeddedSolanaWallet } from '../../utils/wallet'
import { executeSpotPerpClose } from '../../services/spot-perp-close-executor'
import { log } from '../../utils/log'
import { db } from '@paystream/db'
import { spotPerpTrades } from '@paystream/db/schema'
import { and, eq } from 'drizzle-orm'

/**
 * POST /api/trade/spot-perp/close
 * Close a spot-perp hedge: sell spot tokens + close perp short
 */
export async function spotPerpCloseHandler(c: Context) {
  try {
    const authData = c.privyUser
    if (!authData) {
      const response: SpotPerpCloseErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const body = (await c.req.json().catch(() => ({}))) as SpotPerpCloseRequest

    if (!body.tradeId) {
      const response: SpotPerpCloseErrorResponse = {
        status: 'error',
        message: 'Missing required field',
        error: 'Missing required field',
        details: 'tradeId is required',
      }
      return c.json(response, 400)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(authData.user.linked_accounts || [])
    if (!embeddedWallet) {
      const response: SpotPerpCloseErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
      }
      return c.json(response, 400)
    }

    const walletAddress = embeddedWallet.address

    // Verify trade belongs to this user
    const [trade] = await db.select().from(spotPerpTrades)
      .where(and(
        eq(spotPerpTrades.id, body.tradeId),
        eq(spotPerpTrades.userPubkey, walletAddress),
        eq(spotPerpTrades.active, true),
      ))
      .limit(1)

    if (!trade) {
      const response: SpotPerpCloseErrorResponse = {
        status: 'error',
        message: 'Trade not found or already closed',
        error: 'Trade not found',
        details: `No active trade found with ID ${body.tradeId} for this wallet`,
      }
      return c.json(response, 400)
    }

    const privyUserId = authData.user.id
    const result = await executeSpotPerpClose({
      privyUserId,
      tradeId: trade.id,
      market: trade.market,
      spotTokenMint: trade.spotTokenMint,
      perpProtocol: trade.perpProtocol,
      closeReason: 'manual',
    })

    if (result.error && !result.closeSpotTxnHash && !result.closePerpTxnHash) {
      const response: SpotPerpCloseErrorResponse = {
        status: 'error',
        message: result.error,
        error: 'Close failed',
      }
      return c.json(response, 500)
    }

    const isFullClose = result.success
    const response: SpotPerpCloseSuccessResponse = {
      status: isFullClose ? 'success' : 'partial',
      message: isFullClose
        ? `Trade #${trade.id} closed successfully`
        : `Trade #${trade.id} partially closed. ${result.spotError ? 'Spot sell failed.' : ''} ${result.perpError ? 'Perp close failed.' : ''}`.trim(),
      data: {
        tradeId: trade.id,
        closeSpotTxnHash: result.closeSpotTxnHash,
        closePerpTxnHash: result.closePerpTxnHash,
        closePerpOrderId: result.closePerpOrderId,
        spotError: result.spotError,
        perpError: result.perpError,
      },
    }

    return c.json(response)
  } catch (error) {
    log.error('[spot-perp/close] Error:', error instanceof Error ? error.message : error)
    if (error instanceof Error && error.stack) {
      log.error('[spot-perp/close] Stack:', error.stack)
    }

    const errorResponse: SpotPerpCloseErrorResponse = {
      status: 'error',
      message: 'Failed to close trade',
      error: 'Internal server error',
    }
    return c.json(errorResponse, 500)
  }
}
