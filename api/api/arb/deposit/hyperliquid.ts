import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import type { Context } from 'hono'
import {
  getHyperliquidDepositAddress,
  getSupportedDepositAssets,
  validateDepositAmount,
  type HyperliquidDepositAsset,
} from '../../../clients/arb/hyperliquid-deposit'
import {
  createHyperliquidClient,
  formatHyperliquidSize,
} from '@paystream/perps/clients/hyperliquid-client'
import { extractEmbeddedEthWallet, extractEmbeddedSolanaWallet } from '../../../utils/wallet'
import { createEmbeddedEthWallet, createHyperliquidViemAccount, privy, getAuthorizationContext } from '../../../clients/privy'
import { connection } from '../../../clients/solana'
import { serializeTransactionForPrivy } from '../../../utils/transaction'
import { SOLANA_CAIP2 } from '../../../utils/constants'
import { type SupportedToken, isSupportedToken, getTokenConfig, getSwapQuote, executeSwap } from '../../../services/deposit-swap'
import { log } from '../../../utils/log'
import { db } from '@paystream/db'
import { pendingHlConversions, transfers, swaps } from '@paystream/db/schema'
import { parseHlVenue, SUPPORTED_VENUES_MESSAGE } from '@paystream/perps/hip3/dex-config'

const MIN_SOL_DEPOSIT = 0.12
const SOL_GAS_BUFFER = 0.001

// Token name for SOL deposited via Unit protocol
const USOL_TOKEN_NAME = 'USOL'

/**
 * GET /api/arb/deposit/hyperliquid
 * Get supported deposit assets and minimum amounts
 */
export async function hyperliquidDepositInfoHandler(c: Context) {
  try {
    const assets = getSupportedDepositAssets()

    return c.json({
      status: 'success',
      assets,
      note: 'Use POST /api/arb/deposit/hyperliquid with { asset, amount } to execute deposit.',
    })
  } catch (error) {
    log.error('[arb/deposit] Error fetching deposit info:', error)
    return c.json({
      status: 'error',
      message: 'Failed to fetch deposit info',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}

/**
 * POST /api/arb/deposit/hyperliquid
 * Deposit to Hyperliquid via Unit protocol.
 *
 * Request body: { asset: "sol" | "usdc" | "usdt", amount: number }
 *
 * - asset "sol": direct SOL deposit (amount in SOL)
 * - asset "usdc"/"usdt": amount is in that token. Checks existing SOL balance first;
 *   swaps via Jupiter only if the wallet doesn't have enough SOL.
 */
export async function hyperliquidDepositHandler(c: Context) {
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
      /**
       * Target deposit venue. Defaults to `main` (= validator USDC perps,
       * existing behavior). Pass `hl:<dexName>` to route the deposit into a
       * HIP-3 dex's perp account using its native collateral token.
       */
      venue?: string
    }

    const { asset: rawAsset, amount, venue: rawVenue } = body
    const asset = rawAsset?.toLowerCase()

    const parsedVenue = parseHlVenue(rawVenue)
    if (!parsedVenue) {
      return c.json({
        status: 'error',
        message: `Unsupported venue "${rawVenue}". ${SUPPORTED_VENUES_MESSAGE}`,
        error: 'Unsupported venue',
      }, 400)
    }
    const targetVenue = parsedVenue.kind === 'main' ? 'main' : `hl:${parsedVenue.dexName}`
    const targetCollateral = parsedVenue.kind === 'main' ? 'USDC' : parsedVenue.collateral

    if (!asset || !isSupportedToken(asset)) {
      return c.json({
        status: 'error',
        message: 'Invalid asset. Supported: sol, usdc, usdt',
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

    if (asset === 'sol' && amount < MIN_SOL_DEPOSIT) {
      return c.json({
        status: 'error',
        message: `Minimum SOL deposit is ${MIN_SOL_DEPOSIT} SOL`,
        error: 'Amount below minimum',
        minAmount: MIN_SOL_DEPOSIT,
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

    let embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedEthWallet) {
      try {
        embeddedEthWallet = await createEmbeddedEthWallet(authData.user.id)
      } catch (error) {
        log.error('[arb/deposit] Failed to create Ethereum wallet:', error)
        return c.json({
          status: 'error',
          message: 'Failed to create Ethereum wallet',
          error: error instanceof Error ? error.message : 'Unknown error',
        }, 500)
      }
    }

    // Resolve how much SOL to deposit
    let depositAmountSol: number
    let swapTxHash: string | undefined

    if (asset === 'sol') {
      depositAmountSol = amount
    } else {
      // Quote how much SOL this amount of asset is worth
      const quote = await getSwapQuote(asset, 'sol', amount, embeddedSolanaWallet.address)
      const targetSol = quote.outputAmount

      if (targetSol < MIN_SOL_DEPOSIT) {
        const minInput = (MIN_SOL_DEPOSIT / targetSol) * amount
        return c.json({
          status: 'error',
          message: `${amount} ${getTokenConfig(asset).label} ≈ ${targetSol.toFixed(6)} SOL, below minimum deposit of ${MIN_SOL_DEPOSIT} SOL. Try at least ~${Math.ceil(minInput * 100) / 100} ${getTokenConfig(asset).label}.`,
          error: 'Amount below minimum',
        }, 400)
      }

      // Check if existing SOL balance already covers the equivalent amount
      const solBalance = await connection.getBalance(
        new PublicKey(embeddedSolanaWallet.address),
      ) / LAMPORTS_PER_SOL
      const availableSol = solBalance - SOL_GAS_BUFFER

      if (availableSol >= targetSol) {
        depositAmountSol = targetSol
        log.info(`[arb/deposit] Using existing SOL (${availableSol} available, depositing ${targetSol})`)
      } else {
        log.info(`[arb/deposit] SOL balance ${solBalance} < target ${targetSol}, swapping ${amount} ${asset}`)
        const swapResult = await executeSwap(
          asset, 'sol', amount, embeddedSolanaWallet.walletId, embeddedSolanaWallet.address,
        )
        swapTxHash = swapResult.swapTxHash
        depositAmountSol = swapResult.outputAmountHuman

        const inputConfig = getTokenConfig(asset)
        db.insert(swaps).values({
          privyUserId: authData.user.id,
          walletAddress: embeddedSolanaWallet.address,
          inputMint: inputConfig.mint,
          outputMint: getTokenConfig('sol').mint,
          inAmount: swapResult.inputAmount,
          outAmount: swapResult.outputAmount,
          txHash: swapTxHash,
        }).catch(err => log.error('[arb/deposit] Failed to record swap:', err))
      }
    }

    const unitResult = await getHyperliquidDepositAddress(
      embeddedEthWallet.address,
      'sol',
      false,
    )

    const txSignature = await executeSOLTransfer(
      embeddedSolanaWallet,
      unitResult.address,
      depositAmountSol,
      !!swapTxHash, // skip preflight after a swap — RPC simulation uses stale state
    )

    // Queue automatic spot → perp conversion. The poller reads `targetVenue` /
    // `targetCollateral` to decide whether to land funds on the main USDC perp
    // (existing flow) or on a HIP-3 dex's perp balance via `sendAsset`.
    db.insert(pendingHlConversions).values({
      privyUserId: authData.user.id,
      ethAddress: embeddedEthWallet.address.toLowerCase(),
      walletId: embeddedEthWallet.walletId,
      depositTx: txSignature,
      targetVenue,
      targetCollateral,
    }).catch(err => {
      log.error('[arb/deposit] Failed to queue conversion:', err)
    })

    // Record transfer
    db.insert(transfers).values({
      privyUserId: authData.user.id,
      type: 'deposit',
      protocol: 'hyperliquid',
      asset: 'SOL',
      amount: depositAmountSol,
      txHash: txSignature,
      fromAddress: embeddedSolanaWallet.address,
      toAddress: unitResult.address,
      metadata: {
        hyperliquidAddress: embeddedEthWallet.address,
        ...(swapTxHash && { swapTxHash, usdcAmount: amount }),
      },
    }).catch(err => {
      log.error('[arb/deposit] Failed to record transfer:', err)
    })

    return c.json({
      status: 'success',
      message: swapTxHash
        ? `Swapped ${amount} USDC → ${depositAmountSol} SOL and deposited to Hyperliquid`
        : `Deposited ${depositAmountSol} SOL to Hyperliquid`,
      txSignature,
      swapTxHash,
      asset: 'SOL',
      amount: depositAmountSol,
      fromAddress: embeddedSolanaWallet.address,
      depositAddress: unitResult.address,
      hyperliquidAddress: embeddedEthWallet.address,
      note: 'Deposit will be credited to Hyperliquid within ~1 minute. Automatic conversion to perp USDC will follow.',
    })
  } catch (error) {
    log.error('[arb/deposit] Error executing deposit:', error)
    return c.json({
      status: 'error',
      message: 'Failed to execute deposit',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}

/**
 * Execute a native SOL transfer to Unit deposit address
 */
export async function executeSOLTransfer(
  embeddedSolanaWallet: { walletId: string; address: string },
  depositAddress: string,
  amountSol: number,
  skipPreflight = false,
): Promise<string> {
  const fromPubkey = new PublicKey(embeddedSolanaWallet.address)
  const toPubkey = new PublicKey(depositAddress)
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL)

  const transferIx = SystemProgram.transfer({
    fromPubkey,
    toPubkey,
    lamports,
  })

  const tx = new Transaction().add(transferIx)
  tx.feePayer = fromPubkey

  const { blockhash } = await connection.getLatestBlockhash('finalized')
  tx.recentBlockhash = blockhash

  const serializedTx = serializeTransactionForPrivy(tx)
  const authContext = getAuthorizationContext()

  if (skipPreflight) {
    const signed = await privy.wallets().solana().signTransaction(
      embeddedSolanaWallet.walletId,
      { transaction: serializedTx, authorization_context: authContext },
    )
    if (!signed.signed_transaction) throw new Error('Privy did not return a signed transaction')
    return await connection.sendRawTransaction(
      Buffer.from(signed.signed_transaction, 'base64'),
      { skipPreflight: true },
    )
  }

  const result = await privy.wallets().solana().signAndSendTransaction(
    embeddedSolanaWallet.walletId,
    {
      caip2: SOLANA_CAIP2,
      transaction: serializedTx,
      authorization_context: authContext,
    },
  )

  if (!result.hash) {
    throw new Error('Transaction hash not returned from Privy')
  }

  return result.hash
}

/**
 * GET /api/arb/deposit/hyperliquid/:asset (legacy - returns deposit address only)
 * Generate a Solana deposit address for Hyperliquid via Unit protocol
 */
export async function hyperliquidDepositAddressHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    // Extract Ethereum wallet (required for Hyperliquid)
    let embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    // Create Ethereum wallet if it doesn't exist
    if (!embeddedEthWallet) {
      try {
        embeddedEthWallet = await createEmbeddedEthWallet(authData.user.id)
      } catch (error) {
        log.error('[arb/deposit] Failed to create Ethereum wallet:', error)
        return c.json({
          status: 'error',
          message: 'Failed to create Ethereum wallet',
          error: error instanceof Error ? error.message : 'Unknown error',
        }, 500)
      }
    }

    // Get asset from params
    const asset = c.req.param('asset')?.toLowerCase() as HyperliquidDepositAsset

    // Validate asset
    const validAssets: HyperliquidDepositAsset[] = ['sol', 'bonk', 'fartcoin', 'pump', 'spx', '2z']
    if (!asset || !validAssets.includes(asset)) {
      return c.json({
        status: 'error',
        message: `Invalid asset. Supported: ${validAssets.join(', ')}`,
        error: 'Invalid asset',
      }, 400)
    }

    // Generate deposit address via Unit API
    const result = await getHyperliquidDepositAddress(
      embeddedEthWallet.address,
      asset,
      false // mainnet
    )

    // Get minimum deposit amount
    const validation = validateDepositAmount(asset, 0)

    return c.json({
      status: 'success',
      asset: asset.toUpperCase(),
      depositAddress: result.address,
      hyperliquidAddress: embeddedEthWallet.address,
      minDeposit: validation.minAmount,
      signatures: result.signatures,
      note: `Use POST /api/arb/deposit/hyperliquid with { asset: "${asset}", amount: X } to execute deposit.`,
    })
  } catch (error) {
    log.error('[arb/deposit] Error generating deposit address:', error)
    return c.json({
      status: 'error',
      message: 'Failed to generate deposit address',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}

// ==================== Hyperliquid Spot → Perp Convert ====================

/**
 * POST /api/arb/deposit/hyperliquid/convert
 * Convert spot USOL (Unit Solana) to USDC and transfer to perp wallet
 *
 * Flow:
 * 1. Check user's spot balance for USOL
 * 2. Fetch spotMetaAndAssetCtxs for universe index + mid price
 * 3. Sell USOL for USDC via IOC market order
 * 4. Transfer resulting USDC from spot → perp wallet
 */
export async function hyperliquidConvertHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    // Extract Ethereum wallet
    const embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedEthWallet) {
      return c.json({
        status: 'error',
        message: 'No embedded Ethereum wallet found',
        error: 'Ethereum wallet required',
      }, 400)
    }

    // Set up Hyperliquid client with signing
    const hlClient = createHyperliquidClient(embeddedEthWallet.address)
    const authContext = getAuthorizationContext()
    const viemAccount = createHyperliquidViemAccount(
      embeddedEthWallet.walletId,
      embeddedEthWallet.address,
      authContext
    )
    hlClient.setViemAccount(viemAccount)

    // Step 1: Check spot balance — look for USOL (Unit Solana from deposit)
    const spotState = await hlClient.getSpotClearinghouseState()
    log.info(`[arb/deposit] Convert: spot balances=${JSON.stringify(spotState.balances)}`)

    const usolBalance = spotState.balances.find(b => b.coin === USOL_TOKEN_NAME)

    if (!usolBalance) {
      return c.json({
        status: 'success',
        message: 'No USOL balance in spot wallet',
        converted: false,
        balances: spotState.balances.map(b => ({ coin: b.coin, total: b.total })),
      })
    }

    const totalUsol = parseFloat(usolBalance.total)
    const holdUsol = parseFloat(usolBalance.hold)
    const availableUsol = totalUsol - holdUsol

    if (availableUsol <= 0) {
      return c.json({
        status: 'success',
        message: 'No available USOL balance (all on hold)',
        converted: false,
        usolTotal: usolBalance.total,
        usolHold: usolBalance.hold,
      })
    }

    log.info(`[arb/deposit] Convert: USOL balance total=${totalUsol}, hold=${holdUsol}, available=${availableUsol}`)

    // Step 2: Fetch spot meta + allMids to find universe entry and mid price
    const [spotMeta, allMids] = await Promise.all([
      hlClient.getSpotMeta(),
      hlClient.getAllMids(),
    ])

    // Find USOL token to get its index and szDecimals
    const usolToken = spotMeta.tokens.find(t => t.name === USOL_TOKEN_NAME)
    if (!usolToken) {
      return c.json({
        status: 'error',
        message: 'USOL token not found in spot meta',
        error: 'Token not found',
      }, 500)
    }

    // Find the universe pair that includes the USOL token (base token is tokens[0])
    const universeEntry = spotMeta.universe.find(u => u.tokens[0] === usolToken.index)
    if (!universeEntry) {
      return c.json({
        status: 'error',
        message: 'USOL spot market not found in universe',
        error: 'Market not found',
      }, 500)
    }

    const spotAssetIndex = universeEntry.index // actual universe index for order (10000 + this)
    const usolSzDecimals = usolToken.szDecimals

    // Spot mids are keyed as "@{universeIndex}" in allMids
    const spotMidKey = `@${spotAssetIndex}`
    const midPriceStr = allMids[spotMidKey]
    if (!midPriceStr || midPriceStr === '0') {
      return c.json({
        status: 'error',
        message: `Could not fetch USOL mid price (key=${spotMidKey})`,
        error: 'Price unavailable',
      }, 500)
    }

    const midPrice = parseFloat(midPriceStr)
    let formattedSize: string
    try {
      formattedSize = formatHyperliquidSize(availableUsol, usolSzDecimals)
    } catch {
      formattedSize = '0'
    }

    if (formattedSize === '0' || parseFloat(formattedSize) === 0) {
      return c.json({
        status: 'success',
        message: 'USOL balance too small to trade (dust)',
        converted: false,
        usolBalance: usolBalance.total,
      })
    }

    log.info(`[arb/deposit] Convert: Selling ${formattedSize} USOL (universeIndex=${spotAssetIndex}, key=${spotMidKey}, szDecimals=${usolSzDecimals}) at mid=${midPrice}`)

    // Step 3: Sell USOL via IOC spot market order
    const sellResult = await hlClient.placeSpotMarketOrder(
      spotAssetIndex,
      false, // sell
      formattedSize,
      midPrice,
      usolSzDecimals,
      2 // 2% slippage
    )

    // Check sell result
    const sellStatus = sellResult.response?.data?.statuses?.[0]
    if (sellStatus?.error) {
      return c.json({
        status: 'error',
        message: `Failed to sell USOL: ${sellStatus.error}`,
        error: sellStatus.error,
      }, 500)
    }

    const filledInfo = sellStatus?.filled
    log.info(`[arb/deposit] Convert: Sell result - filled=${JSON.stringify(filledInfo)}`)

    // Step 4: Wait briefly for settlement, then check USDC balance
    await new Promise(r => setTimeout(r, 1000))

    const spotStateAfterSell = await hlClient.getSpotClearinghouseState()
    const usdcBalance = spotStateAfterSell.balances.find(b => b.coin === 'USDC')

    if (!usdcBalance) {
      return c.json({
        status: 'error',
        message: 'No USDC balance found after selling USOL',
        error: 'USDC balance missing',
        sellResult: filledInfo,
      }, 500)
    }

    const totalUsdc = parseFloat(usdcBalance.total)
    const holdUsdc = parseFloat(usdcBalance.hold)
    const availableUsdc = totalUsdc - holdUsdc

    if (availableUsdc <= 0) {
      return c.json({
        status: 'error',
        message: 'No available USDC after selling USOL',
        error: 'No transferable USDC',
        usdcTotal: usdcBalance.total,
        usdcHold: usdcBalance.hold,
      }, 500)
    }

    log.info(`[arb/deposit] Convert: USDC available for transfer=${availableUsdc}`)

    // Step 5: Transfer USDC from spot → perp
    // Floor to 2 decimals to avoid transferring more than available
    const transferAmount = Math.floor(availableUsdc * 100) / 100
    const transferResult = await hlClient.usdClassTransfer(
      transferAmount.toString(),
      true // toPerp
    )

    log.info(`[arb/deposit] Convert complete: sold ${formattedSize} USOL, transferred $${transferAmount} USDC to perp`)

    return c.json({
      status: 'success',
      message: `Converted ${formattedSize} USOL to USDC and transferred to perp wallet`,
      converted: true,
      usolSold: formattedSize,
      avgPrice: filledInfo?.avgPx || midPriceStr,
      usdcTransferred: transferAmount.toString(),
      transferResult,
    })
  } catch (error) {
    log.error('[arb/deposit] Convert error:', error)
    return c.json({
      status: 'error',
      message: 'Failed to convert spot to perp USDC',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
