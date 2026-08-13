import { PublicKey } from '@solana/web3.js'
import type { SpotPerpProtocol } from '../models/spot-perp'
import { getInitializedProviders } from '@paystream/perps/registry'
import type { ArbProviderRegistry } from '@paystream/perps/registry'
import type { HyperliquidArbProvider } from '@paystream/perps/providers/hyperliquid-provider'
import { normalizeHyperliquidSymbol } from '@paystream/perps/providers/hyperliquid-provider'
import type { PacificaArbProvider } from '@paystream/perps/providers/pacifica-provider'
import {
  createPacificaPayload,
  executePacificaMarketOrder,
  normalizePacificaSymbol,
} from '@paystream/perps/providers/pacifica-provider'
import { normalizeAsterSymbol } from '@paystream/perps/providers/aster-provider'
import { normalizeLighterSymbol } from '@paystream/perps/providers/lighter-provider'
import type { LighterArbProvider } from '@paystream/perps/providers/lighter-provider'
import type { ZoArbProvider } from '@paystream/perps/providers/zo-provider'
import { getOrCreateAsterApiCredentials } from '../clients/arb/aster-auth'
import { getOrCreateLighterApiCredentials } from '../clients/arb/lighter-auth'
import { getOrCreateZoSession, runWithZoSessionInvalidation } from '../clients/arb/zo-auth'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../utils/wallet'
import { SOLANA_CAIP2, USDC_MINT } from '../utils/constants'
import { getJupiterSwapQuote } from '../swap'
import { privy, getAuthorizationContext, signMessageWithPrivy, createHyperliquidViemAccount } from '../clients/privy'
import { db } from '@paystream/db'
import { spotPerpTrades } from '@paystream/db/schema'
import { and, eq } from 'drizzle-orm'
import { log } from '../utils/log'

export interface SpotPerpCloseParams {
  privyUserId: string
  tradeId: number
  market: string
  spotTokenMint: string
  perpProtocol: string
  closeReason?: string
}

export interface SpotPerpCloseResult {
  success: boolean
  closeSpotTxnHash?: string
  closePerpTxnHash?: string
  closePerpOrderId?: number
  spotError?: string
  perpError?: string
  error?: string
}

/**
 * Execute a spot-perp close on behalf of a user.
 * Used by both the user-facing close handler and the internal worker endpoint.
 */
export async function executeSpotPerpClose(params: SpotPerpCloseParams): Promise<SpotPerpCloseResult> {
  const { privyUserId, tradeId, market, spotTokenMint, perpProtocol, closeReason } = params

  let arbRegistry: ArbProviderRegistry | null = null

  try {
    // Load user from Privy
    const user = await privy.users()._get(privyUserId)
    if (!user) {
      return { success: false, error: 'User not found in Privy' }
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(user.linked_accounts || [])
    if (!embeddedWallet) {
      return { success: false, error: 'No embedded Solana wallet found' }
    }

    const embeddedEthWallet = extractEmbeddedEthWallet(user.linked_accounts || [])
    const walletAddress = embeddedWallet.address
    const walletPubkey = new PublicKey(walletAddress)
    const embeddedWalletId = embeddedWallet.walletId

    // Fetch trade from DB
    const [trade] = await db.select().from(spotPerpTrades)
      .where(and(eq(spotPerpTrades.id, tradeId), eq(spotPerpTrades.active, true)))
      .limit(1)

    if (!trade) {
      return { success: false, error: `No active trade found with ID ${tradeId}` }
    }

    const protocol = trade.perpProtocol as SpotPerpProtocol
    const authContext = getAuthorizationContext()

    // Refuse to touch the trade if its perp leg is on a protocol we no longer
    // support (e.g. legacy Drift). Selling the spot side without closing the
    // short would leave the user with an orphaned, unhedged perp position
    // while the trade is marked closed in the DB.
    const SUPPORTED_PROTOCOLS = ['pacifica', 'hyperliquid', 'aster', 'lighter', '01'] as const
    if (!SUPPORTED_PROTOCOLS.includes(protocol as (typeof SUPPORTED_PROTOCOLS)[number])) {
      const errorMsg = `Unsupported perpProtocol "${protocol}" — close the perp leg manually on the exchange.`
      log.warn(`[spot-perp-close-executor] Rejecting close for trade #${trade.id}: ${errorMsg}`)
      try {
        await db.update(spotPerpTrades)
          .set({ closeError: errorMsg, updatedAt: new Date() })
          .where(eq(spotPerpTrades.id, trade.id))
      } catch {}
      return { success: false, perpError: errorMsg, error: errorMsg }
    }

    log.info(`[spot-perp-close-executor] Closing trade #${trade.id}: ${trade.market} on ${protocol}`)

    // On retries, skip legs that already succeeded in a previous attempt
    const spotAlreadyClosed = !!trade.closeSpotTxnHash
    const perpAlreadyClosed = !!trade.closePerpTxnHash
    const perpNeverOpened = !trade.perpTxnHash

    // For 01: kick off session bootstrap in parallel with the spot sell Jupiter
    // quote + submit. Avoids a serialized Privy round-trip after spot settles.
    const zoSessionPromise = (protocol === '01' && !perpNeverOpened && !perpAlreadyClosed)
      ? getOrCreateZoSession(privyUserId, embeddedWalletId, walletAddress, authContext)
      : Promise.resolve(null)

    // ========================================
    // 1. Sell Spot Tokens (Token -> USDC via Jupiter)
    // ========================================
    let closeSpotTxnHash: string | undefined = trade.closeSpotTxnHash || undefined
    let spotError: string | undefined

    if (spotAlreadyClosed) {
      log.info(`[spot-perp-close-executor] Spot already sold for trade #${trade.id}, skipping`)
    } else try {
      // Use the exact amount from the original spot buy, not the full wallet balance
      const sellAmountSmallest = trade.spotAmount ? parseInt(trade.spotAmount, 10) : 0

      if (!sellAmountSmallest || sellAmountSmallest <= 0) {
        throw new Error(`No spotAmount recorded for trade #${trade.id}`)
      }

      log.info(`[spot-perp-close-executor] Selling ${sellAmountSmallest} smallest units of ${trade.market}`)

      const quoteResponse = await getJupiterSwapQuote({
        inputMint: trade.spotTokenMint,
        outputMint: USDC_MINT,
        amount: sellAmountSmallest,
        taker: walletAddress,
        logPrefix: '[spot-perp-close-executor]',
      })

      if (!quoteResponse.transaction) {
        const reason = quoteResponse.errorMessage || quoteResponse.errorCode
          ? `Jupiter error: ${quoteResponse.errorMessage || ''} (code: ${quoteResponse.errorCode || 'unknown'})`
          : 'Jupiter did not return a swap transaction. This may indicate low liquidity or an unsupported token pair.'
        throw new Error(reason)
      }

      // Jupiter Ultra returns a ready-to-sign transaction with a fresh blockhash.
      // Send directly — skipping decompile/recompile saves ~2s of ALT + blockhash fetches.
      log.info('[spot-perp-close-executor] Sending spot sell transaction...')
      const spotSent = await privy
        .wallets()
        .solana()
        .signAndSendTransaction(embeddedWalletId, {
          caip2: SOLANA_CAIP2,
          transaction: quoteResponse.transaction,
          authorization_context: authContext,
        })

      if (!spotSent.hash) throw new Error('Spot sell transaction hash not returned from Privy')
      closeSpotTxnHash = spotSent.hash
      log.info(`[spot-perp-close-executor] Spot sell sent: ${closeSpotTxnHash}`)
    } catch (error) {
      spotError = error instanceof Error ? error.message : String(error)
      log.error('[spot-perp-close-executor] Spot sell failed:', spotError)
    }

    // ========================================
    // 2. Close Perp Short (skip if perp was never opened)
    // ========================================
    let closePerpTxnHash: string | undefined = trade.closePerpTxnHash || undefined
    let closePerpOrderId: number | undefined = trade.closePerpOrderId ?? undefined
    let perpError: string | undefined

    if (perpNeverOpened) {
      log.info(`[spot-perp-close-executor] Perp leg was never opened for trade #${trade.id}, skipping perp close`)
    } else if (perpAlreadyClosed) {
      log.info(`[spot-perp-close-executor] Perp already closed for trade #${trade.id}, skipping`)
    }

    if (!perpNeverOpened && !perpAlreadyClosed) try {
      arbRegistry = await getInitializedProviders(walletPubkey, embeddedEthWallet?.address, [protocol])

      if (protocol === 'pacifica') {
        const normalizedSymbol = normalizePacificaSymbol(trade.market)
        log.info(`[spot-perp-close-executor] Closing Pacifica short for ${normalizedSymbol}`)

        const pacificaTyped = arbRegistry.getPacificaProvider() as PacificaArbProvider | null
        const lotSize = pacificaTyped?.getLotSize(trade.market) ?? 0.01

        const pacificaProvider = arbRegistry.getProvider('pacifica')
        let closeAmount: string

        if (pacificaProvider) {
          const positions = await pacificaProvider.getPositions(walletPubkey)
          const pos = positions.find(
            p => p.symbol.toUpperCase() === normalizedSymbol.toUpperCase() && p.direction === 'short'
          )
          if (pos) {
            const roundedSize = Math.round(pos.sizeAsset / lotSize) * lotSize
            const decimals = Math.max(0, -Math.floor(Math.log10(lotSize)))
            closeAmount = roundedSize.toFixed(decimals)
          } else {
            throw new Error(`No Pacifica short position found for ${normalizedSymbol}`)
          }
        } else {
          throw new Error('Pacifica provider not available')
        }

        const orderData = {
          symbol: normalizedSymbol,
          amount: closeAmount,
          side: 'bid',
          slippage_percent: '1.0',
          reduce_only: true,
        }
        const { message, timestamp } = createPacificaPayload('create_market_order', orderData)
        const signature = await signMessageWithPrivy(embeddedWalletId, message, authContext)

        const orderResult = await executePacificaMarketOrder({
          account: walletAddress,
          symbol: normalizedSymbol,
          amount: closeAmount,
          side: 'bid',
          reduceOnly: true,
          signature,
          timestamp,
        })

        closePerpTxnHash = `pacifica-close-${orderResult.orderId}`
        closePerpOrderId = orderResult.orderId

      } else if (protocol === 'aster') {
        if (!embeddedEthWallet) throw new Error('Ethereum wallet required for Aster trading')
        const asterProvider = arbRegistry.getAsterProvider()!
        const creds = await getOrCreateAsterApiCredentials(
          privyUserId,
          embeddedEthWallet.address,
          embeddedEthWallet.walletId,
          authContext
        )
        asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)
        const asterSymbol = normalizeAsterSymbol(trade.market).replace(/USDC$/, '')
        log.info(`[spot-perp-close-executor] Closing Aster short for ${asterSymbol}`)
        const result = await asterProvider.executeClose(asterSymbol, 'short')
        closePerpTxnHash = `aster-close-${result.orderId}`
        closePerpOrderId = result.orderId

      } else if (protocol === 'lighter') {
        if (!embeddedEthWallet) throw new Error('Ethereum wallet required for Lighter')
        const lighterProvider = arbRegistry.getLighterProvider()! as LighterArbProvider
        const creds = await getOrCreateLighterApiCredentials(
          privyUserId,
          embeddedEthWallet.address,
          embeddedEthWallet.walletId,
          authContext
        )
        await lighterProvider.setCredentials(creds)
        lighterProvider.setEthAddress(embeddedEthWallet.address)
        const lighterSymbol = normalizeLighterSymbol(trade.market)
        log.info(`[spot-perp-close-executor] Closing Lighter short for ${lighterSymbol}`)
        const result = await lighterProvider.executeClose(lighterSymbol, 'short')
        closePerpTxnHash = `lighter-close-${result.orderId}`
        closePerpOrderId = result.orderId

      } else if (protocol === 'hyperliquid') {
        if (!embeddedEthWallet) throw new Error('Ethereum wallet required for Hyperliquid')
        const hyperliquidProvider = arbRegistry.getHyperliquidProvider()!
        const viemAccount = createHyperliquidViemAccount(
          embeddedEthWallet.walletId,
          embeddedEthWallet.address,
          authContext
        )
        hyperliquidProvider.setViemAccount(viemAccount)

        const hlSymbol = normalizeHyperliquidSymbol(trade.market)
        log.info(`[spot-perp-close-executor] Closing Hyperliquid short for ${hlSymbol}`)

        const result = await hyperliquidProvider.executeClose(hlSymbol, 'short')
        closePerpTxnHash = `hyperliquid-close-${result.orderId}`
        closePerpOrderId = result.orderId

      } else if (protocol === '01') {
        const zoProvider = arbRegistry.getZoProvider() as ZoArbProvider | null
        if (!zoProvider) throw new Error('01 provider not available')

        const session = await zoSessionPromise
        if (!session) throw new Error('01 session missing — pre-bootstrap failed')
        zoProvider.setSession(session)

        // zoProvider.executeClose() matches positions on canonical base symbol,
        // not the "BTCUSD" engine form, so pass the market through as-is.
        log.info(`[spot-perp-close-executor] Closing 01 short for ${trade.market}`)
        const result = await runWithZoSessionInvalidation(privyUserId, () => zoProvider.executeClose(trade.market, 'short', walletPubkey))
        closePerpTxnHash = `01-close-${result.orderId}`
        closePerpOrderId = result.orderId
      }

      log.info(`[spot-perp-close-executor] Perp close completed: ${closePerpTxnHash}`)
    } catch (error) {
      perpError = error instanceof Error ? error.message : String(error)
      log.error('[spot-perp-close-executor] Perp close failed:', perpError)
    }

    // Cleanup registry
    if (arbRegistry) {
      try { await arbRegistry.cleanup() } catch (e) { log.error('[spot-perp-close-executor] Cleanup error:', e) }
      arbRegistry = null
    }

    // Determine success per leg (already-closed counts as success)
    const spotOk = !spotError || spotAlreadyClosed
    const perpOk = perpNeverOpened || perpAlreadyClosed || !perpError

    // Both legs that were attempted this round failed
    if (spotError && !spotAlreadyClosed && (perpError || perpNeverOpened) && !perpAlreadyClosed) {
      const errorDetail = perpNeverOpened
        ? `Spot sell failed: ${spotError}`
        : `Spot: ${spotError}. Perp: ${perpError}`
      try {
        await db.update(spotPerpTrades)
          .set({ closeError: errorDetail, updatedAt: new Date() })
          .where(eq(spotPerpTrades.id, trade.id))
      } catch {}
      return { success: false, spotError, perpError, error: errorDetail }
    }

    // Full close = both legs resolved (success or skipped)
    const isFullClose = spotOk && perpOk
    await db.update(spotPerpTrades)
      .set({
        active: isFullClose ? false : true,
        status: isFullClose ? 'closed' : undefined,
        closeReason: isFullClose ? (closeReason as any) || 'manual' : undefined,
        closeSpotTxnHash: closeSpotTxnHash || null,
        closePerpTxnHash: closePerpTxnHash || null,
        closePerpOrderId: closePerpOrderId ?? null,
        closedAt: isFullClose ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(spotPerpTrades.id, trade.id))

    log.info(`[spot-perp-close-executor] Trade #${trade.id} ${isFullClose ? 'closed' : 'partially closed'} (reason=${closeReason || 'manual'})`)

    return {
      success: isFullClose,
      closeSpotTxnHash,
      closePerpTxnHash,
      closePerpOrderId,
      spotError,
      perpError,
    }
  } catch (error) {
    if (arbRegistry as ArbProviderRegistry | null) {
      try { await arbRegistry!.cleanup() } catch {}
    }
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    log.error('[spot-perp-close-executor] Error:', errorMsg)
    return { success: false, error: errorMsg }
  }
}
