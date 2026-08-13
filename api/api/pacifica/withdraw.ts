import type { Context } from 'hono'
import { extractEmbeddedSolanaWallet } from '../../utils/wallet'
import { getAuthorizationContext, signMessageWithPrivy } from '../../clients/privy'
import { createPacificaPayload, PACIFICA_API_BASE, PACIFICA_HOST, getPacificaIPv4, SIGNATURE_EXPIRY_WINDOW_MS } from '@paystream/perps/providers/pacifica-provider'
/** Pacifica program address for transfer records */
const PACIFICA_PROGRAM_ADDRESS = 'PCFA5iYgmqK6MqPhWNKg7Yv7auX7VZ4Cx7T1eJyrAMH'
import { log } from '../../utils/log'
import { db } from '@paystream/db'
import { transfers } from '@paystream/db/schema'

export interface PacificaWithdrawRequest {
  amount: number | string // Amount in USDC
}

export interface PacificaWithdrawSuccessResponse {
  status: 'success'
  message: string
  data: {
    amount: string
  }
}

export interface PacificaWithdrawErrorResponse {
  status: 'error'
  message: string
  error: string
  details?: string
}

/**
 * POST /api/pacifica/withdraw
 * Withdraw USDC from Pacifica trading account via REST API
 */
export async function withdrawHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      const response: PacificaWithdrawErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const body = (await c.req.json().catch(() => ({}))) as PacificaWithdrawRequest
    log.info('[pacifica/withdraw] Request:', JSON.stringify(body, null, 2))

    // Validate request
    if (body.amount === undefined || body.amount === null) {
      const response: PacificaWithdrawErrorResponse = {
        status: 'error',
        message: 'Missing required field',
        error: 'Missing required field',
        details: 'amount is required',
      }
      return c.json(response, 400)
    }

    const amount = typeof body.amount === 'string' ? parseFloat(body.amount) : body.amount
    if (isNaN(amount) || amount <= 0) {
      const response: PacificaWithdrawErrorResponse = {
        status: 'error',
        message: 'Invalid amount',
        error: 'Invalid amount',
        details: 'amount must be a positive number',
      }
      return c.json(response, 400)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedWallet) {
      const response: PacificaWithdrawErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
        details: 'Embedded Solana wallet is required for signing',
      }
      return c.json(response, 400)
    }

    const walletAddress = embeddedWallet.address
    const embeddedWalletId = embeddedWallet.walletId
    const authContext = getAuthorizationContext()

    // Create signed payload for Pacifica withdraw API
    const { message, timestamp } = createPacificaPayload(
      'withdraw',
      { amount: amount.toString() }
    )

    log.info(`[pacifica/withdraw] Signing withdraw request for ${amount} USDC`)

    const signature = await signMessageWithPrivy(
      embeddedWalletId,
      message,
      authContext
    )

    // Call Pacifica withdraw REST API
    const ipv4 = getPacificaIPv4()
    let url = `${PACIFICA_API_BASE}/api/v1/account/withdraw`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ipv4) {
      url = url.replace(PACIFICA_HOST, ipv4)
      headers['Host'] = PACIFICA_HOST
    }

    const requestBody = {
      account: walletAddress,
      signature,
      timestamp,
      expiry_window: SIGNATURE_EXPIRY_WINDOW_MS,
      amount: amount.toString(),
    }

    log.info(`[pacifica/withdraw] Calling Pacifica withdraw API...`)

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    })

    const resText = await res.text()
    log.info(`[pacifica/withdraw] Pacifica API response: ${res.status} ${resText}`)

    let resData: { success?: boolean; error?: string } = {}
    try {
      resData = JSON.parse(resText)
    } catch {
      // Non-JSON response
    }

    if (!res.ok || (resText && !resData.success)) {
      log.error(`[pacifica/withdraw] Pacifica API error: ${res.status}`, resText)
      const response: PacificaWithdrawErrorResponse = {
        status: 'error',
        message: 'Pacifica withdrawal request failed',
        error: resData.error || resText || `HTTP ${res.status}`,
      }
      return c.json(response, 500)
    }

    log.info(`[pacifica/withdraw] Withdrawal request successful for ${amount} USDC`)

    // Record transfer
    db.insert(transfers).values({
      privyUserId: authData.user.id,
      type: 'withdrawal',
      protocol: 'pacifica',
      asset: 'USDC',
      amount,
      fromAddress: PACIFICA_PROGRAM_ADDRESS,
      toAddress: walletAddress,
    }).catch(err => {
      log.error('[pacifica/withdraw] Failed to record transfer:', err)
    })

    const response: PacificaWithdrawSuccessResponse = {
      status: 'success',
      message: 'Withdrawal requested successfully',
      data: {
        amount: amount.toString(),
      },
    }

    return c.json(response)
  } catch (error) {
    log.error('[pacifica/withdraw] Error:', error instanceof Error ? error.message : error)
    if (error instanceof Error && error.stack) {
      log.error('[pacifica/withdraw] Stack:', error.stack)
    }

    const errorResponse: PacificaWithdrawErrorResponse = {
      status: 'error',
      message: error instanceof Error ? error.message : 'Withdrawal failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    return c.json(errorResponse, 500)
  }
}
