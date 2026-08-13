import type { Context } from 'hono'
import { extractEmbeddedSolanaWallet } from '../../../utils/wallet'
import { createZoClient } from '@paystream/perps/clients/zo-client'
import { getZoInfoCache } from '../../../clients/arb/zo-info-cache'
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
 * GET /api/arb/balance/01
 * Returns the user's 01 account balance. 01 uses the Solana wallet pubkey to
 * look up the Nord account id. No authenticated session is needed for /account.
 */
export async function zoBalanceHandler(c: Context) {
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
        message: 'No Solana wallet found — 01 account not created yet',
        data: EMPTY_BALANCE,
      })
    }

    const client = createZoClient()
    // getAccount depends on userInfo.accountIds[0]; chain it off that promise
    // so the /account fetch overlaps with the /info cache read instead of
    // running serially after both resolve.
    const userInfoPromise = client.getUserInfo(embeddedWallet.address)
    const accountPromise = userInfoPromise.then(u =>
      u?.accountIds?.length ? client.getAccount(u.accountIds[0]) : null,
    )
    const [userInfo, { tokenById }, account] = await Promise.all([
      userInfoPromise,
      getZoInfoCache(client),
      accountPromise,
    ])

    if (!userInfo || userInfo.accountIds.length === 0) {
      return c.json<BalanceSuccessResponse>({
        status: 'success',
        message: 'No 01 account found for this wallet',
        data: EMPTY_BALANCE,
      })
    }

    if (!account) {
      return c.json<BalanceSuccessResponse>({
        status: 'success',
        message: '01 account not found',
        data: EMPTY_BALANCE,
      })
    }

    // 01 denominates account value in USDC (tokenId 0). Other-token balances
    // exist but aren't convertible here without an oracle; report USDC only.
    let usdcBalance = 0
    for (const b of account.balances ?? []) {
      const tok = tokenById.get(b.tokenId)
      if (!tok) continue
      if (tok.symbol.toUpperCase() === 'USDC') usdcBalance += b.amount
    }

    // `margins.imf` is the initial margin requirement in USD per the Nord
    // AccountMargins schema (values are "expressed in USD, value of 1.0000 =
    // 1 USD"). Available-to-trade is the free collateral above that.
    const initialMargin = account.margins?.imf ?? 0
    const availableToTrade = Math.max(usdcBalance - initialMargin, 0)

    let totalPositionValue = 0
    let positionsCount = 0
    for (const pos of account.positions ?? []) {
      if (!pos.perp) continue
      const baseSize = pos.perp.baseSize
      if (!Number.isFinite(baseSize) || baseSize === 0) continue
      positionsCount++
      totalPositionValue += Math.abs(baseSize) * (pos.perp.price ?? 0)
    }

    return c.json<BalanceSuccessResponse>({
      status: 'success',
      message: 'Balance retrieved successfully',
      data: {
        accountValue: usdcBalance.toFixed(2),
        accountEquity: usdcBalance.toFixed(2),
        availableToTrade: availableToTrade.toFixed(2),
        withdrawable: availableToTrade.toFixed(2),
        totalMarginUsed: initialMargin.toFixed(2),
        totalPositionValue: totalPositionValue.toFixed(2),
        positionsCount,
      },
    })
  } catch (error) {
    log.error('[arb/balance] 01 error:', error instanceof Error ? error.message : error)
    return c.json<BalanceErrorResponse>({
      status: 'error',
      message: 'Failed to get 01 balance',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
