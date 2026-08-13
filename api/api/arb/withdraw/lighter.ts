import type { Context } from 'hono'
import { extractEmbeddedEthWallet } from '../../../utils/wallet'
import { getAuthorizationContext, privy } from '../../../clients/privy'
import { getOrCreateLighterApiCredentials } from '../../../clients/arb/lighter-auth'
import { createLighterClient } from '@paystream/perps/clients/lighter-client'
import { signTransfer, createAuthToken } from '@paystream/perps/lighter/signer'
import { log } from '../../../utils/log'
import { db } from '@paystream/db'
import { transfers } from '@paystream/db/schema'

// Lighter SDK constants
const ASSET_ID_USDC = 3
const ROUTE_PERP = 0

/**
 * POST /api/arb/withdraw/lighter
 * Fast withdraw USDC from Lighter perp account to user's L1 ETH address
 *
 * Flow (matches lighter-python fast withdraw):
 * 1. Auth check + extract ETH wallet
 * 2. Get/create Lighter API credentials
 * 3. Verify balance
 * 4. Create auth token, get fast withdraw pool info + transfer fee
 * 5. Sign transfer to pool (perp→perp, memo = ETH address)
 * 6. Sign messageToSign with ETH wallet via Privy (L1 signature)
 * 7. Inject L1Sig into txInfo
 * 8. Submit to /api/v1/fastwithdraw
 */
export async function lighterWithdrawHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const body = (await c.req.json().catch(() => ({}))) as { amount?: number | string }
    log.info('[arb/withdraw/lighter] Request:', JSON.stringify(body, null, 2))

    // Validate amount
    if (body.amount === undefined || body.amount === null) {
      return c.json({
        status: 'error',
        message: 'Missing required field',
        error: 'amount is required',
      }, 400)
    }

    const amount = typeof body.amount === 'string' ? parseFloat(body.amount) : body.amount
    if (isNaN(amount) || amount < 1) {
      return c.json({
        status: 'error',
        message: 'Invalid amount',
        error: 'amount must be at least 1 USDC',
      }, 400)
    }

    // Extract ETH wallet
    const embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )
    if (!embeddedEthWallet) {
      return c.json({
        status: 'error',
        message: 'No embedded Ethereum wallet found',
        error: 'Ethereum wallet required for Lighter withdrawals',
      }, 400)
    }

    const userId = authData.user.id
    const ethAddress = embeddedEthWallet.address
    const ethWalletId = embeddedEthWallet.walletId
    const authContext = getAuthorizationContext()

    // Get or create Lighter API credentials
    log.info(`[arb/withdraw/lighter] Getting Lighter credentials for ${userId}`)
    const creds = await getOrCreateLighterApiCredentials(userId, ethAddress, ethWalletId, authContext)

    // Verify balance
    const lighterClient = createLighterClient()
    const account = await lighterClient.getDetailedAccountByL1Address(ethAddress)
    if (!account) {
      return c.json({
        status: 'error',
        message: 'No Lighter account found',
        error: `No account found for ETH address ${ethAddress}`,
      }, 400)
    }

    const availableBalance = parseFloat(account.available_balance)
    log.info(`[arb/withdraw/lighter] Available balance: ${availableBalance}, requested: ${amount}`)

    // Create auth token for authenticated Lighter API calls
    const deadline = Math.floor(Date.now() / 1000) + 600 // 10 min
    const authToken = await createAuthToken(deadline, creds.apiKeyIndex, creds.accountIndex)
    log.info(`[arb/withdraw/lighter] Auth token created`)

    // Get fast withdraw pool info
    const poolInfo = await lighterClient.getFastWithdrawInfo(creds.accountIndex, authToken)
    const toAccountIndex = poolInfo.to_account_index
    log.info(`[arb/withdraw/lighter] Fast withdraw pool account: ${toAccountIndex}, limit: ${poolInfo.withdraw_limit}`)

    // Get transfer fee
    const feeInfo = await lighterClient.getTransferFeeInfo(creds.accountIndex, toAccountIndex, authToken)
    const transferFee = feeInfo.transfer_fee_usdc
    log.info(`[arb/withdraw/lighter] Transfer fee: ${transferFee}`)

    // Fee is in smallest units (already int from API). Total deducted = amount + fee.
    const feeHuman = transferFee / 1e6
    const totalRequired = amount + feeHuman

    if (availableBalance < totalRequired) {
      return c.json({
        status: 'error',
        message: 'Insufficient balance',
        error: `Available balance (${availableBalance} USDC) is less than amount + fee (${amount} + ${feeHuman} = ${totalRequired} USDC)`,
      }, 400)
    }

    // Get nonce
    const nonce = await lighterClient.getNextNonce(creds.accountIndex, creds.apiKeyIndex)
    log.info(`[arb/withdraw/lighter] Nonce: ${nonce}`)

    // Convert amount to smallest units (6 decimals for USDC)
    const amountSmallest = Math.floor(amount * 1e6)

    // Build memo: 20-byte ETH address + 12 zero bytes (32 bytes total as hex)
    const addrHex = ethAddress.toLowerCase().replace('0x', '')
    const memoHex = addrHex + '0'.repeat(24) // 20 bytes addr + 12 bytes zeros = 32 bytes

    // Sign transfer to fast withdraw pool (perp → perp)
    log.info(`[arb/withdraw/lighter] Signing transfer: to=${toAccountIndex}, amount=${amountSmallest}, fee=${transferFee}`)
    const signedTx = await signTransfer(
      toAccountIndex,
      ASSET_ID_USDC,
      ROUTE_PERP,
      ROUTE_PERP,
      amountSmallest,
      transferFee,
      memoHex,
      nonce,
      creds.apiKeyIndex,
      creds.accountIndex,
    )
    log.info(`[arb/withdraw/lighter] Signed tx type: ${signedTx.txType}, messageToSign: ${signedTx.messageToSign ? 'yes' : 'no'}`)

    // Sign with ETH wallet via Privy (EIP-191 personal_sign) — same as ChangePubKey flow
    if (!signedTx.messageToSign) {
      throw new Error('SignTransfer did not return a messageToSign for L1 signature')
    }

    const signResult = await privy.wallets().ethereum().signMessage(ethWalletId, {
      message: signedTx.messageToSign,
      authorization_context: authContext,
    })

    if (!signResult?.signature) {
      throw new Error('Failed to sign transfer message with Privy ETH wallet')
    }
    log.info(`[arb/withdraw/lighter] L1 signature: ${signResult.signature.slice(0, 20)}...`)

    // Inject L1Sig into txInfo
    const txInfoObj = JSON.parse(signedTx.txInfo)
    txInfoObj.L1Sig = signResult.signature
    const finalTxInfo = JSON.stringify(txInfoObj)

    // Submit fast withdrawal
    const result = await lighterClient.submitFastWithdraw(finalTxInfo, ethAddress, authToken)
    log.info(`[arb/withdraw/lighter] Fast withdraw result: ${JSON.stringify(result)}`)

    if (result.code !== 200) {
      return c.json({
        status: 'error',
        message: 'Fast withdraw failed',
        error: result.message || 'Unknown error',
      }, 500)
    }

    // Record transfer
    db.insert(transfers).values({
      privyUserId: userId,
      type: 'withdrawal',
      protocol: 'lighter',
      asset: 'USDC',
      amount,
      txHash: result.tx_hash,
      fromAddress: ethAddress,
      toAddress: ethAddress,
      metadata: { fee: transferFee },
    }).catch(err => {
      log.error('[arb/withdraw/lighter] Failed to record transfer:', err)
    })

    return c.json({
      status: 'success',
      message: `Fast withdrawal of ${amount} USDC initiated`,
      data: {
        amount,
        txHash: result.tx_hash,
        ethAddress,
        fee: transferFee,
      },
    })
  } catch (error) {
    log.error('[arb/withdraw/lighter] Error:', error instanceof Error ? error.message : error)
    if (error instanceof Error && error.stack) {
      log.error('[arb/withdraw/lighter] Stack:', error.stack)
    }

    return c.json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Withdrawal failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
