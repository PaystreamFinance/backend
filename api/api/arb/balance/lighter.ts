import type { Context } from 'hono'
import { extractEmbeddedEthWallet } from '../../../utils/wallet'
import { createLighterClient } from '@paystream/perps/clients/lighter-client'
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
 * GET /api/arb/balance/lighter
 * Get user's Lighter account balance
 *
 * Lighter uses the user's Ethereum L1 address to look up the account.
 */
export async function lighterBalanceHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json<BalanceErrorResponse>({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedEthWallet) {
      return c.json<BalanceSuccessResponse>({
        status: 'success',
        message: 'No Ethereum wallet found - Lighter account not created yet',
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

    log.info(`[arb/balance] Fetching Lighter balance for ${embeddedEthWallet.address}`)

    const client = createLighterClient()
    const account = await client.getDetailedAccountByL1Address(embeddedEthWallet.address)
    if (!account) {
      return c.json({ protocol: 'lighter', balance: 0, availableBalance: 0, marginUsed: 0, positions: 0, unrealizedPnl: 0 })
    }

    const balance = parseFloat(account.balance || '0')
    const availableBalance = parseFloat(account.available_balance || '0')
    const marginUsed = balance - availableBalance

    // Calculate total position value and unrealized PnL
    let totalPositionValue = 0
    let totalUnrealizedPnl = 0
    const positionsCount = (account.positions || []).filter(p => parseFloat(p.position) !== 0).length

    for (const pos of account.positions || []) {
      totalPositionValue += Math.abs(parseFloat(pos.position_value || '0'))
      totalUnrealizedPnl += parseFloat(pos.unrealized_pnl || '0')
    }

    return c.json<BalanceSuccessResponse>({
      status: 'success',
      message: 'Balance retrieved successfully',
      data: {
        accountValue: balance.toFixed(2),
        accountEquity: (balance + totalUnrealizedPnl).toFixed(2),
        availableToTrade: availableBalance.toFixed(2),
        withdrawable: availableBalance.toFixed(2),
        totalMarginUsed: marginUsed.toFixed(2),
        totalPositionValue: totalPositionValue.toFixed(2),
        positionsCount,
      },
    })
  } catch (error) {
    log.error('[arb/balance] Lighter error:', error instanceof Error ? error.message : error)
    return c.json<BalanceErrorResponse>({
      status: 'error',
      message: 'Failed to get Lighter balance',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
