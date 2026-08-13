import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import { buildAsterDepositTransaction } from '../../../clients/arb/aster-deposit'
import { extractEmbeddedSolanaWallet, getTokenBalance } from '../../../utils/wallet'
import { privy, getAuthorizationContext } from '../../../clients/privy'
import { connection } from '../../../clients/solana'
import { serializeTransactionForPrivy } from '../../../utils/transaction'
import { SOLANA_CAIP2, USDT_MINT, USDT_DECIMALS } from '../../../utils/constants'
import { type SupportedToken, isSupportedToken, getTokenConfig, getSwapQuote, executeSwap } from '../../../services/deposit-swap'
import { log } from '../../../utils/log'
import { db } from '@paystream/db'
import { transfers, swaps } from '@paystream/db/schema'

/**
 * Build, sign, and send an Aster USDT deposit transaction.
 * Shared by the standalone deposit handler and the swap-and-deposit flow.
 */
export async function executeAsterDeposit(
  wallet: { walletId: string; address: string },
  amount: number,
  skipPreflight = false,
): Promise<{ txHash: string; vaultAddress: string }> {
  const walletPubkey = new PublicKey(wallet.address)

  const [depositResult, { blockhash }] = await Promise.all([
    buildAsterDepositTransaction(walletPubkey, amount),
    connection.getLatestBlockhash('finalized'),
  ])
  depositResult.transaction.recentBlockhash = blockhash

  const serializedTx = serializeTransactionForPrivy(depositResult.transaction)
  const authContext = getAuthorizationContext()

  if (skipPreflight) {
    const signed = await privy.wallets().solana().signTransaction(
      wallet.walletId,
      { transaction: serializedTx, authorization_context: authContext },
    )
    if (!signed.signed_transaction) throw new Error('Privy did not return a signed transaction')
    const txHash = await connection.sendRawTransaction(
      Buffer.from(signed.signed_transaction, 'base64'),
      { skipPreflight: true },
    )
    return { txHash, vaultAddress: depositResult.vaultAddress }
  }

  const result = await privy.wallets().solana().signAndSendTransaction(
    wallet.walletId,
    {
      caip2: SOLANA_CAIP2,
      transaction: serializedTx,
      authorization_context: authContext,
    },
  )

  if (!result.hash) {
    throw new Error('Aster deposit transaction hash not returned from Privy')
  }

  return { txHash: result.hash, vaultAddress: depositResult.vaultAddress }
}

/**
 * POST /api/arb/deposit/aster
 * Deposit to Aster via deposit_token program instruction on Solana.
 *
 * Request body: { asset: "usdt" | "usdc" | "sol", amount: number }
 *
 * - asset "usdt": direct USDT deposit (amount in USDT, min 1)
 * - asset "usdc"/"sol": amount is in that token. Checks existing USDT balance first;
 *   swaps via Jupiter only if the wallet doesn't have enough USDT.
 */
export async function asterDepositHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const body = await c.req.json().catch(() => ({})) as {
      asset?: string
      amount?: number
    }

    const asset = (body.asset?.toLowerCase() ?? 'usdt') as string
    const amount = body.amount

    if (!isSupportedToken(asset)) {
      return c.json({
        status: 'error',
        message: 'Invalid asset. Supported: usdt, usdc, sol',
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

    if (asset === 'usdt' && amount < 1) {
      return c.json({
        status: 'error',
        message: 'Minimum deposit is 1 USDT',
        error: 'Amount below minimum',
      }, 400)
    }

    const embeddedSolanaWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedSolanaWallet) {
      return c.json({
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Solana wallet required',
      }, 400)
    }

    let depositAmountUsdt: number
    let swapTxHash: string | undefined

    if (asset === 'usdt') {
      depositAmountUsdt = amount
    } else {
      // Quote how much USDT this amount of asset is worth
      const quote = await getSwapQuote(asset, 'usdt', amount, embeddedSolanaWallet.address)
      const targetUsdt = quote.outputAmount

      if (targetUsdt < 1) {
        const minInput = (1 / targetUsdt) * amount
        return c.json({
          status: 'error',
          message: `${amount} ${getTokenConfig(asset).label} ≈ ${targetUsdt.toFixed(2)} USDT, below minimum deposit of 1 USDT. Try at least ~${Math.ceil(minInput * 100) / 100} ${getTokenConfig(asset).label}.`,
          error: 'Amount below minimum',
        }, 400)
      }

      // Check if existing USDT balance covers the equivalent amount
      const usdtBalance = (await getTokenBalance(
        connection, USDT_MINT, embeddedSolanaWallet.address, USDT_DECIMALS,
      )) ?? 0

      if (usdtBalance >= targetUsdt) {
        depositAmountUsdt = targetUsdt
        log.info(`[arb/deposit] Using existing USDT (${usdtBalance} available, depositing ${targetUsdt})`)
      } else {
        log.info(`[arb/deposit] USDT balance ${usdtBalance} < target ${targetUsdt}, swapping ${amount} ${asset}`)
        const swapResult = await executeSwap(
          asset, 'usdt', amount, embeddedSolanaWallet.walletId, embeddedSolanaWallet.address,
        )
        swapTxHash = swapResult.swapTxHash
        depositAmountUsdt = swapResult.outputAmountHuman

        const inputConfig = getTokenConfig(asset)
        db.insert(swaps).values({
          privyUserId: authData.user.id,
          walletAddress: embeddedSolanaWallet.address,
          inputMint: inputConfig.mint,
          outputMint: getTokenConfig('usdt').mint,
          inAmount: swapResult.inputAmount,
          outAmount: swapResult.outputAmount,
          txHash: swapTxHash,
        }).catch(err => log.error('[arb/deposit] Failed to record swap:', err))
      }
    }

    const { txHash, vaultAddress } = await executeAsterDeposit(
      embeddedSolanaWallet, depositAmountUsdt, !!swapTxHash,
    )

    log.info(`[arb/deposit] Aster deposit: ${depositAmountUsdt} USDT, tx: ${txHash}`)

    db.insert(transfers).values({
      privyUserId: authData.user.id,
      type: 'deposit',
      protocol: 'aster',
      asset: 'USDT',
      amount: depositAmountUsdt,
      txHash,
      fromAddress: embeddedSolanaWallet.address,
      toAddress: vaultAddress,
      metadata: swapTxHash ? { swapTxHash, sourceAsset: asset, sourceAmount: amount } : undefined,
    }).catch(err => {
      log.error('[arb/deposit] Failed to record transfer:', err)
    })

    return c.json({
      status: 'success',
      message: swapTxHash
        ? `Swapped ${amount} ${getTokenConfig(asset as SupportedToken).label} → ${depositAmountUsdt} USDT and deposited to Aster`
        : `Deposited ${depositAmountUsdt} USDT to Aster`,
      txSignature: txHash,
      swapTxHash,
      asset: 'USDT',
      amount: depositAmountUsdt,
      fromAddress: embeddedSolanaWallet.address,
      note: 'Deposit will be credited to your Aster account shortly.',
    })
  } catch (error) {
    log.error('[arb/deposit] Aster deposit error:', error)
    return c.json({
      status: 'error',
      message: 'Failed to execute Aster deposit',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
