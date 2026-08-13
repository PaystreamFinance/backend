import type { Context } from 'hono'
import { extractEmbeddedSolanaWallet } from '../../../utils/wallet'
import { createPhoenixArbProvider } from '@paystream/perps/providers/phoenix-provider'
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

const EMPTY_BALANCE: BalanceSuccessResponse['data'] = {
  accountValue: '0',
  accountEquity: '0',
  availableToTrade: '0',
  withdrawable: '0',
  totalMarginUsed: '0',
  totalPositionValue: '0',
  positionsCount: 0,
}

/**
 * GET /api/arb/balance/phoenix
 * Returns the user's Phoenix collateral. Phoenix uses isolated margin: the
 * main subaccount holds free collateral, and each isolated position has its
 * own subaccount with locked margin. We sum collateral across all
 * subaccounts, mark open positions to market, and report the unallocated main
 * pool collateral as available/withdrawable.
 */
export async function phoenixBalanceHandler(c: Context) {
  try {
    const authData = c.privyUser
    if (!authData) {
      return c.json<BalanceErrorResponse>({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(authData.user.linked_accounts || [])
    if (!embeddedWallet) {
      return c.json<BalanceSuccessResponse>({
        status: 'success',
        message: 'No Solana wallet found — Phoenix account not created yet',
        data: EMPTY_BALANCE,
      })
    }

    const provider = createPhoenixArbProvider()
    const balance = await provider.getBalance(embeddedWallet.address)

    return c.json<BalanceSuccessResponse>({
      status: 'success',
      message: 'Balance retrieved successfully',
      data: {
        accountValue: balance.accountEquityUsdc.toFixed(2),
        accountEquity: balance.accountEquityUsdc.toFixed(2),
        availableToTrade: balance.freeUsdc.toFixed(2),
        withdrawable: balance.freeUsdc.toFixed(2),
        totalMarginUsed: balance.lockedUsdc.toFixed(2),
        totalPositionValue: balance.totalPositionValueUsdc.toFixed(2),
        positionsCount: balance.positionsCount,
      },
    })
  } catch (error) {
    log.error('[arb/balance] phoenix error:', error instanceof Error ? error.message : error)
    return c.json<BalanceErrorResponse>({
      status: 'error',
      message: 'Failed to get Phoenix balance',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
