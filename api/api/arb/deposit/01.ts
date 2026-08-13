import type { Context } from 'hono'
import { extractEmbeddedSolanaWallet, getTokenBalance } from '../../../utils/wallet'
import { getAuthorizationContext } from '../../../clients/privy'
import { connection } from '../../../clients/solana'
import { USDC_MINT, USDC_DECIMALS } from '../../../utils/constants'
import { type SupportedToken, isSupportedToken, getTokenConfig, getSwapQuote, executeSwap } from '../../../services/deposit-swap'
import { createZoNordUserForDeposit } from '../../../clients/arb/zo-sdk'
import { formatZoErrorResponse } from '../../../clients/arb/zo-errors'
import { log } from '../../../utils/log'
import { db } from '@paystream/db'
import { transfers, swaps } from '@paystream/db/schema'
import { PublicKey } from '@solana/web3.js'

// 01 mainnet USDC has tokenId=0. Minimum deposit 1 USDC per /proton/v0/config.
const ZO_USDC_TOKEN_ID = 0
const MIN_USDC_DEPOSIT = 1

/**
 * POST /api/arb/deposit/01
 * Deposit USDC into the user's 01 (Nord) account via the SDK's Anchor
 * `deposit` instruction. Accepts USDC directly, or swaps from USDT/SOL first.
 */
export async function zoDepositHandler(c: Context) {
  try {
    const authData = c.privyUser
    if (!authData) {
      return c.json({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      asset?: string
      amount?: number
    }

    const asset = (body.asset?.toLowerCase() ?? 'usdc') as string
    const amount = body.amount

    if (!isSupportedToken(asset)) {
      return c.json({
        status: 'error',
        message: 'Invalid asset. Supported: usdc, usdt, sol',
        error: 'Invalid asset',
      }, 400)
    }

    if (!amount || amount <= 0) {
      return c.json({
        status: 'error',
        message: 'Amount must be a positive number',
        error: 'Invalid amount',
      }, 400)
    }

    if (asset === 'usdc' && amount < MIN_USDC_DEPOSIT) {
      return c.json({
        status: 'error',
        message: `Minimum deposit is ${MIN_USDC_DEPOSIT} USDC`,
        error: 'Amount below minimum',
      }, 400)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(authData.user.linked_accounts || [])
    if (!embeddedWallet) {
      return c.json({
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Solana wallet required',
      }, 400)
    }

    let depositAmountUsdc: number
    let swapTxHash: string | undefined
    let swapRecord: typeof swaps.$inferInsert | null = null

    const readUsdcBalance = () => getTokenBalance(
      connection, new PublicKey(USDC_MINT), new PublicKey(embeddedWallet.address), USDC_DECIMALS,
    ).then(b => b ?? 0)

    if (asset === 'usdc') {
      const usdcBalance = await readUsdcBalance()
      if (usdcBalance < amount) {
        return c.json({
          status: 'error',
          message: `Insufficient USDC balance. Wallet has ${usdcBalance.toFixed(2)} USDC, tried to deposit ${amount} USDC.`,
          error: 'Insufficient balance',
          walletBalance: usdcBalance,
        }, 400)
      }
      depositAmountUsdc = amount
    } else {
      // Quote and balance are independent — overlap them to shave a Jupiter RTT.
      const [quote, usdcBalance] = await Promise.all([
        getSwapQuote(asset, 'usdc', amount, embeddedWallet.address),
        readUsdcBalance(),
      ])
      const targetUsdc = quote.outputAmount

      if (targetUsdc < MIN_USDC_DEPOSIT) {
        const minInput = (MIN_USDC_DEPOSIT / targetUsdc) * amount
        return c.json({
          status: 'error',
          message: `${amount} ${getTokenConfig(asset).label} ≈ ${targetUsdc.toFixed(2)} USDC, below minimum deposit of ${MIN_USDC_DEPOSIT} USDC. Try at least ~${Math.ceil(minInput * 100) / 100} ${getTokenConfig(asset).label}.`,
          error: 'Amount below minimum',
        }, 400)
      }

      if (usdcBalance >= targetUsdc) {
        depositAmountUsdc = targetUsdc
        log.info(`[arb/deposit] 01: using existing USDC (${usdcBalance} available, depositing ${targetUsdc})`)
      } else {
        log.info(`[arb/deposit] 01: USDC balance ${usdcBalance} < target ${targetUsdc}, swapping ${amount} ${asset}`)
        const swapResult = await executeSwap(
          asset, 'usdc', amount, embeddedWallet.walletId, embeddedWallet.address,
        )
        swapTxHash = swapResult.swapTxHash
        depositAmountUsdc = swapResult.outputAmountHuman

        const inputConfig = getTokenConfig(asset)
        swapRecord = {
          privyUserId: authData.user.id,
          walletAddress: embeddedWallet.address,
          inputMint: inputConfig.mint,
          outputMint: getTokenConfig('usdc').mint,
          inAmount: swapResult.inputAmount,
          outAmount: swapResult.outputAmount,
          txHash: swapTxHash,
        }
      }
    }

    const authContext = getAuthorizationContext()
    const nordUser = await createZoNordUserForDeposit({
      embeddedWallet,
      authContext,
    })

    log.info(`[arb/deposit] 01: depositing ${depositAmountUsdc} USDC via SDK for ${embeddedWallet.address}`)
    const { signature, buffer } = await nordUser.deposit({
      amount: depositAmountUsdc,
      tokenId: ZO_USDC_TOKEN_ID,
    })
    log.info(`[arb/deposit] 01: deposit tx sent: ${signature} (buffer=${buffer.toBase58()})`)

    // Tx is already on-chain — we can't roll back if the audit insert fails,
    // so surface a reconciliation warning instead of silently dropping it.
    let recordingWarning: string | undefined
    try {
      if (swapRecord) await db.insert(swaps).values(swapRecord)
      await db.insert(transfers).values({
        privyUserId: authData.user.id,
        type: 'deposit',
        protocol: '01',
        asset: 'USDC',
        amount: depositAmountUsdc,
        txHash: signature,
        fromAddress: embeddedWallet.address,
        toAddress: null,
        metadata: {
          bufferAccount: buffer.toBase58(),
          ...(swapTxHash ? { swapTxHash, sourceAsset: asset, sourceAmount: amount } : {}),
        },
      })
    } catch (err) {
      log.error(`[arb/deposit] 01: Audit-log insert failed for user=${authData.user.id} tx=${signature}:`, err)
      recordingWarning = `Deposit submitted on-chain (tx=${signature}) but audit record failed. Contact support with the tx signature if the balance does not appear.`
    }

    return c.json({
      status: 'success',
      message: swapTxHash
        ? `Swapped ${amount} ${getTokenConfig(asset as SupportedToken).label} → ${depositAmountUsdc} USDC and deposited to 01`
        : `Deposited ${depositAmountUsdc} USDC to 01`,
      txSignature: signature,
      swapTxHash,
      asset: 'USDC',
      amount: depositAmountUsdc,
      fromAddress: embeddedWallet.address,
      note: 'Deposit will be credited to your 01 account once confirmed on-chain.',
      warning: recordingWarning,
    })
  } catch (error) {
    log.error('[arb/deposit] 01 deposit error:', error)
    const { body, status } = formatZoErrorResponse(error, 'Failed to execute 01 deposit')
    return c.json(body, status as 400 | 401 | 500 | 503)
  }
}
