import type { Context } from 'hono'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../../utils/wallet'
import { getAuthorizationContext, createHyperliquidViemAccount, getWalletById } from '../../../clients/privy'
import {
  createHyperliquidClient,
  formatHyperliquidSize,
  type HyperliquidClient,
  type HyperliquidSpotClearinghouseState,
} from '@paystream/perps/clients/hyperliquid-client'
import { getHyperliquidWithdrawAddress, HYPERLIQUID_MIN_DEPOSITS } from '../../../clients/arb/hyperliquid-deposit'
import { parseHlVenue, SUPPORTED_VENUES_MESSAGE, type Hip3Collateral } from '@paystream/perps/hip3/dex-config'
import { hlSpotSwap } from '@paystream/perps/hip3/spot-swap'
import { log } from '../../../utils/log'
import { db } from '@paystream/db'
import { transfers } from '@paystream/db/schema'

const USOL_TOKEN_NAME = 'USOL'

// Unit's per-asset minimum (deposit AND withdraw direction). Sending less than
// this via spotSend either fails or gets dust-stuck — pre-flight against it.
const MIN_USOL_WITHDRAW = HYPERLIQUID_MIN_DEPOSITS.sol

// Spot balance polling — sendAsset/usdClassTransfer settles within a few HL blocks.
const SPOT_POLL_INTERVAL_MS = 750
const SPOT_POLL_TIMEOUT_MS = 12_000

export interface HyperliquidWithdrawRequest {
  /**
   * Amount in collateral units (USDC for `main`/USDC dexes, USDH/USDE/USDT0 for
   * HIP-3 dexes). For HIP-3 the non-USDC collaterals are pegged ~1:1 so this is
   * effectively USD. Pass `"max"` or omit to withdraw the full withdrawable
   * balance from the source venue.
   */
  amount?: number | string
  /**
   * Source venue. Defaults to `main` (validator USDC perps). Pass
   * `hl:<dexName>` to withdraw from a HIP-3 dex's perp balance — the runner
   * will send the dex's collateral back to spot, swap to USDC if needed,
   * then bridge SOL out via Unit.
   */
  venue?: string
}

export interface HyperliquidWithdrawSuccessResponse {
  status: 'success'
  message: string
  data: {
    amount: string
    usolBought: string
    spotSendResult: any
    unitWithdrawAddress: string
    solanaDestination: string
  }
}

export interface HyperliquidWithdrawErrorResponse {
  status: 'error'
  message: string
  error: string
  details?: string
}

function getSpotAvailable(state: HyperliquidSpotClearinghouseState, coin: string): number {
  const bal = state.balances.find(b => b.coin === coin)
  if (!bal) return 0
  const total = parseFloat(bal.total)
  const hold = parseFloat(bal.hold)
  return Number.isFinite(total) && Number.isFinite(hold) ? total - hold : 0
}

function getPositiveDelta(current: number, baseline: number): number {
  const delta = current - baseline
  return delta > 0 ? delta : 0
}

/**
 * Poll spot clearinghouse until `coin`'s available balance reaches `target`.
 * Returns the final state and balance — callers can reuse the state for
 * sibling balance lookups without an extra round-trip.
 */
async function pollSpotBalance(
  hlClient: HyperliquidClient,
  coin: string,
  target: number,
): Promise<{ state: HyperliquidSpotClearinghouseState; avail: number }> {
  const deadline = Date.now() + SPOT_POLL_TIMEOUT_MS
  while (true) {
    const state = await hlClient.getSpotClearinghouseState()
    const avail = getSpotAvailable(state, coin)
    if (avail >= target || Date.now() >= deadline) return { state, avail }
    await new Promise(r => setTimeout(r, SPOT_POLL_INTERVAL_MS))
  }
}

/**
 * POST /api/arb/withdraw/hyperliquid
 * Withdraw from a Hyperliquid perp account to the user's Solana wallet via
 * Unit bridge.
 *
 * Flow:
 *   1. Read perp clearinghouse (cap amount to withdrawable; "max" supported).
 *   2. Move collateral from the source perp → spot:
 *      - main USDC perp: usdClassTransfer
 *      - HIP-3 dex: sendAsset (collateral may be USDC, USDH, USDE, or USDT0)
 *   3. If collateral != USDC: market-sell the entire spot collateral balance
 *      for USDC. Otherwise this step is a no-op.
 *   4. Buy USOL with the resulting spot USDC (~99% with slippage buffer).
 *   5. Wait for USOL settlement on spot.
 *   6. Resolve per-address Unit withdraw address and spotSend USOL there;
 *      Unit guardians bridge it as native SOL to the user's Solana wallet.
 */
export async function hyperliquidWithdrawHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    const body = (await c.req.json().catch(() => ({}))) as HyperliquidWithdrawRequest
    log.info('[arb/withdraw/hl] Request:', JSON.stringify(body, null, 2))

    const parsedVenue = parseHlVenue(body.venue)
    if (!parsedVenue) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: `Unsupported venue "${body.venue}". ${SUPPORTED_VENUES_MESSAGE}`,
        error: 'Unsupported venue',
      }, 400)
    }

    const isMaxAmount =
      body.amount === undefined ||
      body.amount === null ||
      (typeof body.amount === 'string' && body.amount.toLowerCase() === 'max')

    let requestedAmount = 0
    if (!isMaxAmount) {
      requestedAmount = typeof body.amount === 'string' ? parseFloat(body.amount as string) : (body.amount as number)
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
        return c.json<HyperliquidWithdrawErrorResponse>({
          status: 'error',
          message: 'Invalid amount',
          error: 'amount must be a positive number or "max"',
        }, 400)
      }
    }

    // Need both Solana wallet (destination) and ETH wallet (HL signing)
    const embeddedSolanaWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )
    if (!embeddedSolanaWallet) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Solana wallet required for receiving SOL',
      }, 400)
    }

    let embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )
    if (!embeddedEthWallet) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: 'No embedded Ethereum wallet found',
        error: 'Ethereum wallet required for Hyperliquid operations',
      }, 400)
    }

    // Verify ETH wallet address
    const verifiedWallet = await getWalletById(embeddedEthWallet.walletId)
    if (verifiedWallet && verifiedWallet.address !== embeddedEthWallet.address) {
      log.warn(`[arb/withdraw/hl] ETH wallet address mismatch, using verified: ${verifiedWallet.address}`)
      embeddedEthWallet = { ...embeddedEthWallet, address: verifiedWallet.address }
    }

    const authContext = getAuthorizationContext()
    const hlClient = createHyperliquidClient(embeddedEthWallet.address)
    const viemAccount = createHyperliquidViemAccount(
      embeddedEthWallet.walletId,
      embeddedEthWallet.address,
      authContext
    )
    hlClient.setViemAccount(viemAccount)

    const sourceDexName = parsedVenue.kind === 'main' ? '' : parsedVenue.dexName
    const collateral: Hip3Collateral = parsedVenue.kind === 'main' ? 'USDC' : parsedVenue.collateral
    const venueName = parsedVenue.kind === 'main' ? 'main' : `hl:${parsedVenue.dexName}`

    // === Step 1: read perp + spot baselines, spot meta, and mids in parallel. ===
    const [perpState, preTransferSpot, spotMeta, allMids] = await Promise.all([
      hlClient.getClearinghouseState(undefined, sourceDexName),
      hlClient.getSpotClearinghouseState(),
      hlClient.getSpotMeta(),
      hlClient.getAllMids(),
    ])

    // Resolve the USOL spot market once — used for the pre-flight projection
    // and the actual buy at Step 4.
    const usolToken = spotMeta.tokens.find(t => t.name === USOL_TOKEN_NAME)
    if (!usolToken) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: 'USOL token not found in spot meta',
        error: 'Token not found',
      }, 500)
    }
    const universeEntry = spotMeta.universe.find(u => u.tokens[0] === usolToken.index)
    if (!universeEntry) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: 'USOL spot market not found',
        error: 'Market not found',
      }, 500)
    }
    const spotAssetIndex = universeEntry.index
    const usolSzDecimals = usolToken.szDecimals
    const spotMidKey = `@${spotAssetIndex}`
    const midPriceStr = allMids[spotMidKey]
    if (!midPriceStr || midPriceStr === '0') {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: `Could not fetch USOL mid price (key=${spotMidKey})`,
        error: 'Price unavailable',
      }, 500)
    }
    const midPrice = parseFloat(midPriceStr)

    const withdrawable = parseFloat(perpState.withdrawable || '0')
    if (!Number.isFinite(withdrawable) || withdrawable <= 0) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: `No withdrawable balance on ${venueName}`,
        error: 'No withdrawable balance',
      }, 400)
    }

    const desired = isMaxAmount ? withdrawable : Math.min(requestedAmount, withdrawable)
    const transferAmount = Math.floor(desired * 100) / 100
    if (transferAmount <= 0) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: `Withdrawable too small (${withdrawable} ${collateral})`,
        error: 'Dust amount',
      }, 400)
    }

    // Pre-flight: project the USOL we'll be able to spotSend out. Reject if
    // it falls under Unit's minimum, before moving any funds. For non-USDC
    // collateral the swap eats up to ~5% on slippage; we then keep ~99% on
    // the USOL buy. Same coefficients used in the live flow below.
    const projectedUsdc = collateral === 'USDC' ? transferAmount : transferAmount * 0.95
    const projectedUsol = (projectedUsdc * 0.99) / midPrice
    if (projectedUsol < MIN_USOL_WITHDRAW) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message:
          `Withdrawal too small: ${transferAmount} ${collateral} would yield ~${projectedUsol.toFixed(4)} USOL, ` +
          `Unit requires at least ${MIN_USOL_WITHDRAW} USOL. Increase amount or top up the venue.`,
        error: 'Below Unit minimum',
      }, 400)
    }

    const preCollateral = getSpotAvailable(preTransferSpot, collateral)
    const preUsdc = getSpotAvailable(preTransferSpot, 'USDC')

    log.info(
      `[arb/withdraw/hl] venue=${venueName} collateral=${collateral} ` +
      `requested=${isMaxAmount ? 'max' : requestedAmount} withdrawable=${withdrawable} → transferring ${transferAmount}`,
    )

    // === Step 2: perp → spot ===
    if (parsedVenue.kind === 'main') {
      log.info(`[arb/withdraw/hl] Step 2: usdClassTransfer ${transferAmount} USDC main perp → spot`)
      await hlClient.usdClassTransfer(transferAmount.toString(), false)
    } else {
      log.info(`[arb/withdraw/hl] Step 2: sendAsset ${transferAmount} ${collateral} from ${parsedVenue.dexName} perp → spot`)
      const collateralToken = spotMeta.tokens.find(t => t.name === collateral)
      if (!collateralToken) {
        return c.json<HyperliquidWithdrawErrorResponse>({
          status: 'error',
          message: `Spot token ${collateral} not found in Hyperliquid spotMeta`,
          error: 'Token not found',
        }, 500)
      }
      await hlClient.sendAsset({
        sourceDex: parsedVenue.dexName,
        destinationDex: 'spot',
        token: `${collateralToken.name}:${collateralToken.tokenId}`,
        amount: transferAmount.toString(),
      })
    }

    // === Step 3: wait for collateral to land in spot, then (if needed) swap to USDC. ===
    // For USDC venues the funds arrive directly as USDC; otherwise we sell the
    // entire arrived collateral spot balance for USDC.
    let postSpot: HyperliquidSpotClearinghouseState
    let usdcDelta: number

    if (collateral === 'USDC') {
      const arrivalTarget = preUsdc + transferAmount * 0.99
      const { state, avail } = await pollSpotBalance(hlClient, 'USDC', arrivalTarget)
      usdcDelta = getPositiveDelta(avail, preUsdc)
      if (usdcDelta <= 0) {
        return c.json<HyperliquidWithdrawErrorResponse>({
          status: 'error',
          message: `USDC did not arrive in spot wallet within ${SPOT_POLL_TIMEOUT_MS}ms`,
          error: 'Spot transfer timed out',
        }, 504)
      }
      postSpot = state
    } else {
      const arrivalTarget = preCollateral + transferAmount * 0.99
      const arrival = await pollSpotBalance(hlClient, collateral, arrivalTarget)
      const collateralDelta = getPositiveDelta(arrival.avail, preCollateral)
      if (collateralDelta <= 0) {
        return c.json<HyperliquidWithdrawErrorResponse>({
          status: 'error',
          message: `${collateral} did not arrive in spot wallet within ${SPOT_POLL_TIMEOUT_MS}ms`,
          error: 'Spot transfer timed out',
        }, 504)
      }

      log.info(`[arb/withdraw/hl] Step 3: swap ${collateralDelta} ${collateral} → USDC on spot`)
      const swapResult = await hlSpotSwap(hlClient, spotMeta, {
        base: collateral,
        side: 'sell',
        amount: collateralDelta,
      })

      const filledQuoteEstimate =
        swapResult.filledSize && swapResult.avgPx
          ? swapResult.filledSize * swapResult.avgPx
          : 0
      const usdcTarget = filledQuoteEstimate > 0
        ? preUsdc + filledQuoteEstimate * 0.95
        : preUsdc + 0.000001
      const swapped = await pollSpotBalance(hlClient, 'USDC', usdcTarget)
      usdcDelta = getPositiveDelta(swapped.avail, preUsdc)
      if (usdcDelta <= 0) {
        return c.json<HyperliquidWithdrawErrorResponse>({
          status: 'error',
          message: `USDC did not appear after selling ${collateral}`,
          error: 'Swap settlement timed out',
        }, 504)
      }
      postSpot = swapped.state
    }

    // === Step 4: Buy USOL with available USDC on spot. ===
    log.info(`[arb/withdraw/hl] Step 4: Buying USOL with ${usdcDelta} USDC`)

    // Spend ~99% of this withdrawal's USDC on USOL (1% buffer for slippage).
    const usolAmount = (usdcDelta * 0.99) / midPrice
    const formattedSize = formatHyperliquidSize(usolAmount, usolSzDecimals)

    if (formattedSize === '0' || parseFloat(formattedSize) === 0 || parseFloat(formattedSize) < MIN_USOL_WITHDRAW) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: `USOL buy size ${formattedSize} below Unit minimum ${MIN_USOL_WITHDRAW}`,
        error: 'Below Unit minimum',
      }, 400)
    }

    log.info(`[arb/withdraw/hl] Buying ${formattedSize} USOL at mid=${midPrice} (universeIndex=${spotAssetIndex}, usdcDelta=${usdcDelta})`)

    const buyResult = await hlClient.placeSpotMarketOrder(
      spotAssetIndex,
      true, // buy
      formattedSize,
      midPrice,
      usolSzDecimals,
      2 // 2% slippage
    )

    const buyStatus = buyResult.response?.data?.statuses?.[0]
    if (buyStatus?.error) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: `Failed to buy USOL: ${buyStatus.error}`,
        error: buyStatus.error,
      }, 500)
    }

    const filledInfo = buyStatus?.filled
    log.info(`[arb/withdraw/hl] Buy result: filled=${JSON.stringify(filledInfo)}`)

    // === Step 5: wait for USOL to land in spot. ===
    const usolBaseline = getSpotAvailable(postSpot, USOL_TOKEN_NAME)
    const buyFilledSize = filledInfo?.totalSz ? parseFloat(filledInfo.totalSz) : 0
    const usolTarget = buyFilledSize > 0 ? usolBaseline + buyFilledSize * 0.95 : usolBaseline + 0.000001
    const { avail: usolAvailable } = await pollSpotBalance(hlClient, USOL_TOKEN_NAME, usolTarget)
    const usolDelta = getPositiveDelta(usolAvailable, usolBaseline)
    if (usolDelta <= 0) {
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: 'USOL did not appear after spot buy',
        error: 'USOL settlement timed out',
      }, 504)
    }

    const sendSize = formatHyperliquidSize(usolDelta, usolSzDecimals)
    if (parseFloat(sendSize) < MIN_USOL_WITHDRAW) {
      // Should be caught by pre-flight, but slippage on the buy could still
      // dip us under. Don't fire spotSend — it would either be rejected by
      // Unit or get dust-stuck.
      return c.json<HyperliquidWithdrawErrorResponse>({
        status: 'error',
        message: `Bought ${sendSize} USOL but Unit requires at least ${MIN_USOL_WITHDRAW}. Funds are sitting on HL spot.`,
        error: 'Below Unit minimum after buy',
      }, 500)
    }
    log.info(`[arb/withdraw/hl] USOL available to send: ${sendSize}`)

    // === Step 6: spotSend USOL to per-address Unit withdraw destination. ===
    log.info(`[arb/withdraw/hl] Step 6: Resolving Unit withdraw address for Solana dest ${embeddedSolanaWallet.address}`)

    const unitResult = await getHyperliquidWithdrawAddress(
      embeddedSolanaWallet.address,
      'sol',
      false // mainnet
    )

    log.info(`[arb/withdraw/hl] Step 6: Sending ${sendSize} USOL to Unit address ${unitResult.address}`)

    const spotSendResult = await hlClient.spotSend(
      unitResult.address,
      `${USOL_TOKEN_NAME}:${usolToken.tokenId}`,
      sendSize
    )

    log.info(`[arb/withdraw/hl] Withdraw complete: sent ${sendSize} USOL via Unit → SOL will arrive at ${embeddedSolanaWallet.address}`)

    db.insert(transfers).values({
      privyUserId: authData.user.id,
      type: 'withdrawal',
      protocol: 'hyperliquid',
      asset: 'SOL',
      amount: transferAmount,
      fromAddress: embeddedEthWallet.address,
      toAddress: embeddedSolanaWallet.address,
      metadata: {
        venue: venueName,
        collateral,
        usolBought: sendSize,
        unitWithdrawAddress: unitResult.address,
        spotSendResult,
      },
    }).catch(err => {
      log.error('[arb/withdraw/hl] Failed to record transfer:', err)
    })

    return c.json<HyperliquidWithdrawSuccessResponse>({
      status: 'success',
      message: `Withdrawal initiated: ${sendSize} USOL sent via Unit bridge to Solana`,
      data: {
        amount: transferAmount.toString(),
        usolBought: sendSize,
        spotSendResult,
        unitWithdrawAddress: unitResult.address,
        solanaDestination: embeddedSolanaWallet.address,
      },
    })
  } catch (error) {
    log.error('[arb/withdraw/hl] Error:', error instanceof Error ? error.message : error)
    if (error instanceof Error && error.stack) {
      log.error('[arb/withdraw/hl] Stack:', error.stack)
    }

    return c.json<HyperliquidWithdrawErrorResponse>({
      status: 'error',
      message: error instanceof Error ? error.message : 'Withdrawal failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
