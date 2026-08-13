import type { Context } from 'hono'
import { extractEmbeddedEthWallet } from '../../../utils/wallet'
import { createHyperliquidClient } from '@paystream/perps/clients/hyperliquid-client'
import {
  parseHlVenue,
  SUPPORTED_VENUES_MESSAGE,
  type Hip3Collateral,
} from '@paystream/perps/hip3/dex-config'
import { log } from '../../../utils/log'

interface BalanceSuccessResponse {
  status: 'success'
  message: string
  data: {
    accountValue: string
    accountEquity: string
    availableToTrade: string
    withdrawable: string
    totalMarginUsed: string
    totalPositionValue: string
    positionsCount: number
    quoteUnit: Hip3Collateral
  }
}

interface BalanceErrorResponse {
  status: 'error'
  message: string
  error: string
}

/**
 * GET /api/arb/balance/hyperliquid
 * Get user's Hyperliquid account balance and info.
 * Optional `?venue=<id>` query param (`main` or `hl:<dex>`) scopes the read to
 * a HIP-3 builder-deployed perp dex; defaults to `main` (validator USDC perps).
 */
export async function hyperliquidBalanceHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json<BalanceErrorResponse>({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const rawVenue = c.req.query('venue')
    const venue = parseHlVenue(rawVenue)
    if (!venue) {
      return c.json<BalanceErrorResponse>({
        status: 'error',
        message: `Unsupported venue "${rawVenue}". ${SUPPORTED_VENUES_MESSAGE}`,
        error: 'Unsupported venue',
      }, 400)
    }

    const dex = venue.kind === 'hip3' ? venue.dexName : ''
    const quoteUnit: Hip3Collateral = venue.kind === 'hip3' ? venue.collateral : 'USDC'

    const embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedEthWallet) {
      return c.json<BalanceSuccessResponse>({
        status: 'success',
        message: 'No Ethereum wallet found - Hyperliquid account not created yet',
        data: {
          accountValue: '0',
          accountEquity: '0',
          availableToTrade: '0',
          withdrawable: '0',
          totalMarginUsed: '0',
          totalPositionValue: '0',
          positionsCount: 0,
          quoteUnit,
        },
      })
    }

    log.info(`[arb/balance] Fetching Hyperliquid balance for ${embeddedEthWallet.address} (venue=${dex ? `hl:${dex}` : 'main'})`)

    const client = createHyperliquidClient(embeddedEthWallet.address, false)
    const state = await client.getClearinghouseState(undefined, dex)

    const positionsCount = state.assetPositions.filter(
      ap => parseFloat(ap.position.szi) !== 0
    ).length

    return c.json<BalanceSuccessResponse>({
      status: 'success',
      message: 'Balance retrieved successfully',
      data: {
        accountValue: state.crossMarginSummary.accountValue,
        accountEquity: state.marginSummary.accountValue,
        availableToTrade: (
          parseFloat(state.crossMarginSummary.accountValue) -
          parseFloat(state.crossMarginSummary.totalMarginUsed)
        ).toFixed(2),
        withdrawable: state.withdrawable,
        totalMarginUsed: state.crossMarginSummary.totalMarginUsed,
        totalPositionValue: state.crossMarginSummary.totalNtlPos,
        positionsCount,
        quoteUnit,
      },
    })
  } catch (error) {
    log.error('[arb/balance] Hyperliquid error:', error instanceof Error ? error.message : error)
    return c.json<BalanceErrorResponse>({
      status: 'error',
      message: 'Failed to get Hyperliquid balance',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
