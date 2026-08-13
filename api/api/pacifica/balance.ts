import type { Context } from 'hono'
import { extractEmbeddedSolanaWallet } from '../../utils/wallet'
import { log } from '../../utils/log'
import {
  PACIFICA_API_BASE,
  PACIFICA_HOST,
  getPacificaIPv4,
} from '@paystream/perps/providers/pacifica-provider'

/**
 * Pacifica account info from API
 */
interface PacificaAccountInfo {
  balance: string
  fee_level: number
  maker_fee: string
  taker_fee: string
  account_equity: string
  available_to_spend: string
  available_to_withdraw: string
  pending_balance: string
  total_margin_used: string
  cross_mmr: string
  positions_count: number
  orders_count: number
  stop_orders_count: number
  updated_at: number
  use_ltp_for_stop_orders: boolean
}

interface PacificaBalanceSuccessResponse {
  status: 'success'
  message: string
  data: {
    balance: string
    accountEquity: string
    availableToSpend: string
    availableToWithdraw: string
    totalMarginUsed: string
    pendingBalance: string
    feeLevel: number
    makerFee: string
    takerFee: string
    positionsCount: number
    ordersCount: number
  }
}

interface PacificaBalanceErrorResponse {
  status: 'error'
  message: string
  error: string
}

/**
 * GET /api/pacifica/balance
 * Get user's Pacifica account balance and info
 */
export async function balanceHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      const response: PacificaBalanceErrorResponse = {
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
      const response: PacificaBalanceErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
      }
      return c.json(response, 400)
    }

    const account = embeddedWallet.address

    // Build URL with IPv4 if available
    let apiUrl = `${PACIFICA_API_BASE}/api/v1/account?account=${account}`
    const headers: Record<string, string> = {}

    const ipv4 = getPacificaIPv4()
    if (ipv4) {
      apiUrl = apiUrl.replace(PACIFICA_HOST, ipv4)
      headers['Host'] = PACIFICA_HOST
    }

    log.info(`[pacifica/balance] Fetching balance for ${account}`)

    const response = await fetch(apiUrl, { headers })
    const responseText = await response.text()

    if (!response.ok) {
      log.error(`[pacifica/balance] API error: ${response.status} ${responseText}`)
      return c.json({
        status: 'error',
        message: 'Failed to fetch Pacifica balance',
        error: responseText || `HTTP ${response.status}`,
      } as PacificaBalanceErrorResponse, 500)
    }

    const result = JSON.parse(responseText)

    if (!result.success || !result.data) {
      // Account doesn't exist on Pacifica yet
      const emptyResponse: PacificaBalanceSuccessResponse = {
        status: 'success',
        message: 'No Pacifica account found for this wallet',
        data: {
          balance: '0',
          accountEquity: '0',
          availableToSpend: '0',
          availableToWithdraw: '0',
          totalMarginUsed: '0',
          pendingBalance: '0',
          feeLevel: 0,
          makerFee: '0',
          takerFee: '0',
          positionsCount: 0,
          ordersCount: 0,
        },
      }
      return c.json(emptyResponse)
    }

    const data = result.data as PacificaAccountInfo

    const successResponse: PacificaBalanceSuccessResponse = {
      status: 'success',
      message: 'Balance retrieved successfully',
      data: {
        balance: data.balance,
        accountEquity: data.account_equity,
        availableToSpend: data.available_to_spend,
        availableToWithdraw: data.available_to_withdraw,
        totalMarginUsed: data.total_margin_used,
        pendingBalance: data.pending_balance,
        feeLevel: data.fee_level,
        makerFee: data.maker_fee,
        takerFee: data.taker_fee,
        positionsCount: data.positions_count,
        ordersCount: data.orders_count,
      },
    }

    return c.json(successResponse)
  } catch (error) {
    log.error('[pacifica/balance] Error:', error instanceof Error ? error.message : error)

    const errorResponse: PacificaBalanceErrorResponse = {
      status: 'error',
      message: 'Failed to get Pacifica balance',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    return c.json(errorResponse, 500)
  }
}
