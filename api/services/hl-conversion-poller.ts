import { db } from '@paystream/db'
import { pendingHlConversions } from '@paystream/db/schema'
import { and, asc, count, eq, lte, sql } from 'drizzle-orm'
import {
  createHyperliquidClient,
  formatHyperliquidSize,
} from '@paystream/perps/clients/hyperliquid-client'
import { createHyperliquidViemAccount, getAuthorizationContext } from '../clients/privy'
import { parseHip3ProtocolId, type Hip3Collateral } from '@paystream/perps/hip3/dex-config'
import { hlSpotSwap } from '@paystream/perps/hip3/spot-swap'
import { log } from '../utils/log'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'

// Token name for SOL deposited via Unit protocol
const USOL_TOKEN_NAME = 'USOL'

// Max attempts before marking as failed
const MAX_ATTEMPTS = 5

// Poll interval when there are pending entries (5 seconds)
const ACTIVE_POLL_INTERVAL_MS = 5_000

// Poll interval when idle — just checking for new entries (30 seconds)
const IDLE_POLL_INTERVAL_MS = 30_000

// Minimum age before first attempt (wait for deposit to land on HL)
const MIN_AGE_MS = 30_000


/**
 * Process a single pending conversion entry.
 * Returns true if the entry should be removed (completed or no balance).
 */
async function processConversion(entry: {
  id: number
  ethAddress: string
  walletId: string
  attempts: number
  targetVenue: string
  targetCollateral: string
}): Promise<void> {
  const { id, ethAddress, walletId, targetVenue, targetCollateral } = entry

  // Resolve HIP-3 target dex once, up-front, so a misconfigured row fails fast.
  const hip3DexName = targetVenue === 'main' ? null : parseHip3ProtocolId(targetVenue)
  if (targetVenue !== 'main' && !hip3DexName) {
    log.error(`[hl-convert] Entry ${id}: invalid targetVenue=${targetVenue}, marking failed`)
    await db.update(pendingHlConversions)
      .set({ status: 'failed', lastError: `invalid targetVenue ${targetVenue}`, updatedAt: new Date() })
      .where(eq(pendingHlConversions.id, id))
    return
  }
  const collateralSymbol = targetCollateral.toUpperCase() as Hip3Collateral

  try {
    // Mark as converting
    await db.update(pendingHlConversions)
      .set({ status: 'converting', attempts: sql`${pendingHlConversions.attempts} + 1`, updatedAt: new Date() })
      .where(eq(pendingHlConversions.id, id))

    // Set up HL client with signing
    const hlClient = createHyperliquidClient(ethAddress)
    const authContext = getAuthorizationContext()
    const viemAccount = createHyperliquidViemAccount(walletId, ethAddress, authContext)
    hlClient.setViemAccount(viemAccount)

    // Check spot USOL balance
    const spotState = await hlClient.getSpotClearinghouseState()
    const usolBalance = spotState.balances.find(b => b.coin === USOL_TOKEN_NAME)

    if (!usolBalance) {
      // No USOL balance — deposit hasn't arrived yet, or already converted elsewhere.
      // Recovery path: if collateral is already in spot, finish the deposit by
      // moving it to the target venue.
      const usdcBalance = spotState.balances.find(b => b.coin === 'USDC')
      const availableUsdc = usdcBalance ? parseFloat(usdcBalance.total) - parseFloat(usdcBalance.hold) : 0

      // Main USDC perp recovery (existing behavior).
      if (targetVenue === 'main' && availableUsdc > 0.01) {
        const transferAmount = Math.floor(availableUsdc * 100) / 100
        await hlClient.usdClassTransfer(transferAmount.toString(), true)
        log.info(`[hl-convert] Entry ${id}: No USOL, transferred $${transferAmount} spot USDC to main perp`)
        await db.update(pendingHlConversions)
          .set({ status: 'completed', usdcTransferred: transferAmount.toString(), updatedAt: new Date() })
          .where(eq(pendingHlConversions.id, id))
        return
      }

      // HIP-3 recovery: if the target collateral is already in spot, move it.
      if (hip3DexName) {
        const collatBalance = spotState.balances.find(b => b.coin === collateralSymbol)
        const availableCollat = collatBalance ? parseFloat(collatBalance.total) - parseFloat(collatBalance.hold) : 0
        if (availableCollat > 0.01) {
          const sendAmount = (Math.floor(availableCollat * 100) / 100).toString()
          const tokenId = await hlClient.resolveSpotTokenId(collateralSymbol)
          await hlClient.sendAsset({
            sourceDex: 'spot',
            destinationDex: hip3DexName,
            token: tokenId,
            amount: sendAmount,
          })
          log.info(`[hl-convert] Entry ${id}: No USOL, sent ${sendAmount} ${collateralSymbol} from spot → ${hip3DexName} perp`)
          await db.update(pendingHlConversions)
            .set({ status: 'completed', usdcTransferred: sendAmount, updatedAt: new Date() })
            .where(eq(pendingHlConversions.id, id))
          return
        }
      }

      // No USOL and no meaningful collateral — mark as no_balance and remove
      log.info(`[hl-convert] Entry ${id}: No USOL balance for ${ethAddress}, removing`)
      await db.update(pendingHlConversions)
        .set({ status: 'no_balance', updatedAt: new Date() })
        .where(eq(pendingHlConversions.id, id))
      return
    }

    const totalUsol = parseFloat(usolBalance.total)
    const holdUsol = parseFloat(usolBalance.hold)
    const availableUsol = totalUsol - holdUsol

    if (availableUsol <= 0) {
      // All on hold, retry later
      await db.update(pendingHlConversions)
        .set({ status: 'pending', lastError: 'USOL on hold', updatedAt: new Date() })
        .where(eq(pendingHlConversions.id, id))
      return
    }

    // Fetch spot meta + mid price
    const [spotMeta, allMids] = await Promise.all([
      hlClient.getSpotMeta(),
      hlClient.getAllMids(),
    ])

    const usolToken = spotMeta.tokens.find(t => t.name === USOL_TOKEN_NAME)
    if (!usolToken) throw new Error('USOL token not found in spot meta')

    const universeEntry = spotMeta.universe.find(u => u.tokens[0] === usolToken.index)
    if (!universeEntry) throw new Error('USOL universe entry not found')

    const spotMidKey = `@${universeEntry.index}`
    const midPriceStr = allMids[spotMidKey]
    if (!midPriceStr || midPriceStr === '0') throw new Error(`No mid price for ${spotMidKey}`)

    const midPrice = parseFloat(midPriceStr)
    let formattedSize: string
    try {
      formattedSize = formatHyperliquidSize(availableUsol, usolToken.szDecimals)
    } catch {
      formattedSize = '0'
    }

    if (formattedSize === '0' || parseFloat(formattedSize) === 0) {
      // Dust balance, too small to trade — treat as no balance
      log.info(`[hl-convert] Entry ${id}: USOL balance too small to trade (${availableUsol}), removing`)
      await db.update(pendingHlConversions)
        .set({ status: 'no_balance', updatedAt: new Date() })
        .where(eq(pendingHlConversions.id, id))
      return
    }

    log.info(`[hl-convert] Entry ${id}: Selling ${formattedSize} USOL at mid=${midPrice}`)

    // Sell USOL
    const sellResult = await hlClient.placeSpotMarketOrder(
      universeEntry.index,
      false,
      formattedSize,
      midPrice,
      usolToken.szDecimals,
      2,
    )

    const sellStatus = sellResult.response?.data?.statuses?.[0]
    if (sellStatus?.error) throw new Error(`Sell failed: ${sellStatus.error}`)

    const filledInfo = sellStatus?.filled

    // Brief pause for settlement
    await new Promise(r => setTimeout(r, 1500))

    // Check USDC balance and transfer to perp
    const spotStateAfter = await hlClient.getSpotClearinghouseState()
    const usdcBalance = spotStateAfter.balances.find(b => b.coin === 'USDC')

    if (!usdcBalance) throw new Error('No USDC balance after selling USOL')

    const totalUsdc = parseFloat(usdcBalance.total)
    const holdUsdc = parseFloat(usdcBalance.hold)
    const availableUsdc = totalUsdc - holdUsdc

    if (availableUsdc <= 0) throw new Error('No available USDC after sell')

    const transferAmount = Math.floor(availableUsdc * 100) / 100
    let finalAmount = transferAmount
    let finalSymbol: string = 'USDC'

    if (collateralSymbol !== 'USDC') {
      await hlSpotSwap(hlClient, spotMeta, { base: collateralSymbol, side: 'buy', amount: transferAmount })
      await new Promise(r => setTimeout(r, 1500))
      const stateAfter = await hlClient.getSpotClearinghouseState()
      const balAfter = stateAfter.balances.find(b => b.coin === collateralSymbol)
      const available = balAfter ? parseFloat(balAfter.total) - parseFloat(balAfter.hold) : 0
      if (available <= 0) throw new Error(`No available ${collateralSymbol} after swap`)
      finalAmount = available
      finalSymbol = collateralSymbol
    }

    if (targetVenue === 'main') {
      // Main USDC perp — existing flow (collateral must be USDC at this point).
      await hlClient.usdClassTransfer(transferAmount.toString(), true)
      log.info(`[hl-convert] Entry ${id}: Sold ${formattedSize} USOL, transferred $${transferAmount} USDC → main perp`)
    } else {
      // HIP-3 perp dex — sendAsset moves the collateral straight from spot
      // into the dex's perp balance.
      const tokenId = await hlClient.resolveSpotTokenId(finalSymbol)
      const sendAmount = (Math.floor(finalAmount * 100) / 100).toString()
      await hlClient.sendAsset({
        sourceDex: 'spot',
        destinationDex: hip3DexName!,
        token: tokenId,
        amount: sendAmount,
      })
      log.info(`[hl-convert] Entry ${id}: Sold ${formattedSize} USOL → ${transferAmount} USDC, sent ${sendAmount} ${finalSymbol} → ${hip3DexName} perp`)
    }

    await db.update(pendingHlConversions)
      .set({
        status: 'completed',
        usolSold: formattedSize,
        usdcTransferred: transferAmount.toString(),
        updatedAt: new Date(),
      })
      .where(eq(pendingHlConversions.id, id))
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    log.error(`[hl-convert] Entry ${id} failed (attempt ${entry.attempts + 1}):`, msg)

    const newStatus = entry.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending'
    if (newStatus === 'failed') {
      sendOpsAlert({
        key: `hl-convert-failed-${id}`,
        severity: AlertSeverity.WARNING,
        title: 'HL conversion failed permanently',
        message: `Entry ${id} for ${entry.ethAddress}: ${msg}`,
        service: 'api',
      })
    }
    await db.update(pendingHlConversions)
      .set({ status: newStatus, lastError: msg, updatedAt: new Date() })
      .where(eq(pendingHlConversions.id, id))
      .catch(() => {})
  }
}

/**
 * Poll and process all pending conversions.
 * Returns true if there are still pending entries (to drive adaptive polling).
 */
async function pollConversions(): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - MIN_AGE_MS)

    const pending = await db.select().from(pendingHlConversions)
      .where(and(
        eq(pendingHlConversions.status, 'pending'),
        lte(pendingHlConversions.createdAt, cutoff),
      ))
      .orderBy(asc(pendingHlConversions.createdAt))

    if (pending.length === 0) {
      // Check if there are any entries still waiting for MIN_AGE (not yet eligible)
      const [result] = await db.select({ count: count() }).from(pendingHlConversions)
        .where(eq(pendingHlConversions.status, 'pending'))
      return (result?.count ?? 0) > 0
    }

    log.info(`[hl-convert] Processing ${pending.length} pending conversions`)

    for (const entry of pending) {
      await processConversion(entry)
    }

    return true
  } catch (error) {
    log.error('[hl-convert] Poll error:', error)
    sendOpsAlert({
      key: 'hl-convert-poll-error',
      severity: AlertSeverity.WARNING,
      title: 'HL conversion poller error',
      message: error instanceof Error ? error.message : String(error),
      service: 'api',
      error,
    })
    return false
  }
}

/**
 * Start the HL conversion poller.
 * Polls every 5s while entries are pending, backs off to 30s when idle.
 */
export function startHlConversionPoller(): void {
  log.info(`[hl-convert] Starting poller (active=${ACTIVE_POLL_INTERVAL_MS}ms, idle=${IDLE_POLL_INTERVAL_MS}ms, maxAttempts=${MAX_ATTEMPTS})`)

  let timer: ReturnType<typeof setTimeout>

  async function tick() {
    const hasPending = await pollConversions()
    const nextInterval = hasPending ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS
    timer = setTimeout(tick, nextInterval)
  }

  // First poll after short delay
  timer = setTimeout(tick, 5000)
}
