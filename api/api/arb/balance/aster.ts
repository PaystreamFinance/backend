import type { Context } from 'hono'
import { extractEmbeddedSolanaWallet } from '../../../utils/wallet'
import { createAsterClient } from '@paystream/perps/clients/aster-client'
import { getOrCreateAsterApiCredentials } from '../../../clients/arb/aster-auth'
import { getAuthorizationContext } from '../../../clients/privy'
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
  }
}

interface BalanceErrorResponse {
  status: 'error'
  message: string
  error: string
}

/**
 * GET /api/arb/balance/aster
 * Get user's Aster futures account balance
 *
 * Automatically authenticates with Aster if no cached credentials exist.
 */
export async function asterBalanceHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json<BalanceErrorResponse>({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const embeddedSolWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedSolWallet) {
      return c.json<BalanceSuccessResponse>({
        status: 'success',
        message: 'No embedded Solana wallet found — Aster account not created yet',
        data: {
          accountValue: '0',
          accountEquity: '0',
          availableToTrade: '0',
          withdrawable: '0',
          totalMarginUsed: '0',
          totalPositionValue: '0',
          positionsCount: 0,
        },
      })
    }

    // Get or create API credentials (authenticates with Aster via Solana signMessage)
    const authContext = getAuthorizationContext()
    const creds = await getOrCreateAsterApiCredentials(
      authData.user.id,
      embeddedSolWallet.address,
      embeddedSolWallet.walletId,
      authContext
    )

    log.info(`[arb/balance] Fetching Aster balance for ${authData.user.id}`)

    const client = createAsterClient()
    client.setApiCredentials(creds.apiKey, creds.apiSecret)

    const balances = await client.getBalance()

    // Sum across all assets
    let totalBalance = 0
    let totalAvailable = 0
    let totalCrossUnPnl = 0
    let totalMaxWithdraw = 0

    for (const entry of balances) {
      totalBalance += parseFloat(entry.balance || '0')
      totalAvailable += parseFloat(entry.availableBalance || '0')
      totalCrossUnPnl += parseFloat(entry.crossUnPnl || '0')
      totalMaxWithdraw += parseFloat(entry.maxWithdrawAmount || '0')
    }

    const marginUsed = totalBalance - totalAvailable

    // Fetch position count
    let positionsCount = 0
    try {
      const positions = await client.getPositionRisk()
      positionsCount = positions.filter(p => parseFloat(p.positionAmt) !== 0).length
    } catch {
      // Non-critical
    }

    return c.json<BalanceSuccessResponse>({
      status: 'success',
      message: 'Balance retrieved successfully',
      data: {
        accountValue: totalBalance.toFixed(2),
        accountEquity: (totalBalance + totalCrossUnPnl).toFixed(2),
        availableToTrade: totalAvailable.toFixed(2),
        withdrawable: totalMaxWithdraw.toFixed(2),
        totalMarginUsed: marginUsed.toFixed(2),
        totalPositionValue: '0',
        positionsCount,
      },
    })
  } catch (error) {
    log.error('[arb/balance] Aster error:', error instanceof Error ? error.message : error)
    return c.json<BalanceErrorResponse>({
      status: 'error',
      message: 'Failed to get Aster balance',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
