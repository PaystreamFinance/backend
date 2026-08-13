import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import type {
  SpotPerpTradeRequest,
  SpotPerpTradeSuccessResponse,
  SpotPerpTradeErrorResponse,
  SpotPerpProtocol,
} from '../../models/spot-perp'
import { connection } from '../../clients/solana'
import { privy, getAuthorizationContext, signMessageWithPrivy, createHyperliquidViemAccount, getWalletById } from '../../clients/privy'
import { getInitializedProviders, getCachedMarketData } from '@paystream/perps/registry'
import type { ArbProviderRegistry } from '@paystream/perps/registry'
import type { HyperliquidArbProvider } from '@paystream/perps/providers/hyperliquid-provider'
import type { PacificaArbProvider } from '@paystream/perps/providers/pacifica-provider'
import type { AsterArbProvider } from '@paystream/perps/providers/aster-provider'
import type { LighterArbProvider } from '@paystream/perps/providers/lighter-provider'
import type { ZoArbProvider } from '@paystream/perps/providers/zo-provider'
import {
  createPacificaPayload,
  executePacificaMarketOrder,
  normalizePacificaSymbol,
  setPacificaLeverage,
} from '@paystream/perps/providers/pacifica-provider'
import { normalizeHyperliquidSymbol } from '@paystream/perps/providers/hyperliquid-provider'
import { normalizeAsterSymbol } from '@paystream/perps/providers/aster-provider'
import { getOrCreateAsterApiCredentials } from '../../clients/arb/aster-auth'
import { normalizeLighterSymbol } from '@paystream/perps/providers/lighter-provider'
import { getOrCreateLighterApiCredentials } from '../../clients/arb/lighter-auth'
import { getOrCreateZoSession, runWithZoSessionInvalidation } from '../../clients/arb/zo-auth'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet, getTokenBalance } from '../../utils/wallet'
import { SOLANA_CAIP2, USDC_MINT, USDC_DECIMALS } from '../../utils/constants'
import { getJupiterSwapQuote } from '../../swap'
import { parsePrivyError } from '../../utils/error'
import { log } from '../../utils/log'
import { db } from '@paystream/db'
import { spotPerpTrades } from '@paystream/db/schema'
import { eq } from 'drizzle-orm'

/**
 * Normalize base symbol to protocol-specific market format
 */
function normalizeMarketSymbol(baseSymbol: string, protocol: SpotPerpProtocol): string {
  const cleanSymbol = baseSymbol.replace(/-PERP$/i, '').toUpperCase()

  switch (protocol) {
    case 'pacifica':
      return normalizePacificaSymbol(cleanSymbol)
    case 'hyperliquid':
      return normalizeHyperliquidSymbol(cleanSymbol)
    case 'aster':
      return normalizeAsterSymbol(cleanSymbol)
    case 'lighter':
      return normalizeLighterSymbol(cleanSymbol)
    case '01':
      // zoProvider's public API (`getMarketSpec`, `executeTrade`, `executeClose`,
      // and the ArbMarketInfo surfaced via `zoMarkets`) all key on the canonical
      // base symbol, not the "BTCUSD" engine form.
      return cleanSymbol
    default:
      return cleanSymbol
  }
}

/**
 * Validate that a market exists on the specified protocol
 */
async function validateMarketExists(
  baseSymbol: string,
  protocol: SpotPerpProtocol,
  arbRegistry: ArbProviderRegistry | null
): Promise<{ valid: true; symbol: string; oraclePrice?: number } | { valid: false; error: string }> {
  const normalizedSymbol = normalizeMarketSymbol(baseSymbol, protocol)

  switch (protocol) {
    case 'pacifica': {
      const { pacificaMarkets } = await getCachedMarketData()
      const pacificaMarket = pacificaMarkets.find(
        m => m.symbol.toUpperCase() === normalizedSymbol.toUpperCase()
      )
      if (!pacificaMarket) return { valid: false, error: `Market ${normalizedSymbol} not found on Pacifica` }
      return { valid: true, symbol: normalizedSymbol, oraclePrice: pacificaMarket.oraclePrice }
    }

    case 'hyperliquid': {
      const { hyperliquidMarkets } = await getCachedMarketData()
      const hlMarket = hyperliquidMarkets.find(
        m => m.symbol.toUpperCase() === normalizedSymbol.toUpperCase()
      )
      if (!hlMarket) return { valid: false, error: `Market ${normalizedSymbol} not found on Hyperliquid` }
      return { valid: true, symbol: normalizedSymbol, oraclePrice: hlMarket.oraclePrice }
    }

    case 'aster': {
      const { asterMarkets } = await getCachedMarketData()
      const asterMarket = asterMarkets.find(
        m => m.symbol.toUpperCase() === normalizedSymbol.toUpperCase()
      )
      if (!asterMarket) return { valid: false, error: `Market ${normalizedSymbol} not found on Aster` }
      return { valid: true, symbol: normalizedSymbol, oraclePrice: asterMarket.oraclePrice }
    }

    case 'lighter': {
      const { lighterMarkets } = await getCachedMarketData()
      const lighterMarket = lighterMarkets.find(
        m => m.symbol.toUpperCase() === normalizedSymbol.toUpperCase()
      )
      if (!lighterMarket) return { valid: false, error: `Market ${normalizedSymbol} not found on Lighter` }
      return { valid: true, symbol: normalizedSymbol, oraclePrice: lighterMarket.oraclePrice }
    }

    case '01': {
      const { zoMarkets } = await getCachedMarketData()
      const zoMarket = zoMarkets.find(
        m => m.symbol.toUpperCase() === normalizedSymbol.toUpperCase()
      )
      if (!zoMarket) return { valid: false, error: `Market ${normalizedSymbol} not found on 01` }
      return { valid: true, symbol: normalizedSymbol, oraclePrice: zoMarket.oraclePrice }
    }

    default:
      return { valid: false, error: `Unknown protocol: ${protocol}` }
  }
}

/**
 * POST /api/trade/spot-perp
 * Create a delta-neutral position: spot buy + perp short
 */
export async function spotPerpTradeHandler(c: Context) {
  let arbRegistry: ArbProviderRegistry | null = null

  try {
    const authData = c.privyUser
    if (!authData) {
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const body = (await c.req.json().catch(() => ({}))) as SpotPerpTradeRequest
    log.info('[spot-perp] Request:', JSON.stringify(body, null, 2))

    // Validate inputs
    if (!body.totalUsd || body.totalUsd <= 0) {
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: 'Missing required field',
        error: 'Missing required field',
        details: 'totalUsd is required and must be positive',
      }
      return c.json(response, 400)
    }

    if (!body.market) {
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: 'Missing required field',
        error: 'Missing required field',
        details: 'market is required (e.g. "SOL", "BTC", "ETH")',
      }
      return c.json(response, 400)
    }

    if (!body.perpProtocol) {
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: 'Missing required field',
        error: 'Missing required field',
        details: 'perpProtocol is required (pacifica, hyperliquid, aster, lighter, or 01)',
      }
      return c.json(response, 400)
    }

    const validProtocols: SpotPerpProtocol[] = ['pacifica', 'hyperliquid', 'aster', 'lighter', '01']
    if (!validProtocols.includes(body.perpProtocol)) {
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: 'Invalid protocol',
        error: 'Invalid protocol',
        details: `perpProtocol must be one of: ${validProtocols.join(', ')}`,
      }
      return c.json(response, 400)
    }

    if (!body.leverage || body.leverage < 1) {
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: 'Invalid leverage',
        error: 'Invalid leverage',
        details: 'leverage must be at least 1',
      }
      return c.json(response, 400)
    }

    if (!body.spotTokenMint) {
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: 'Missing required field',
        error: 'Missing required field',
        details: 'spotTokenMint is required',
      }
      return c.json(response, 400)
    }

    // Validate spotTokenMint is a valid public key
    try {
      new PublicKey(body.spotTokenMint)
    } catch {
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: 'Invalid spotTokenMint',
        error: 'Invalid spotTokenMint',
        details: 'spotTokenMint must be a valid Solana public key',
      }
      return c.json(response, 400)
    }

    const protocol = body.perpProtocol
    const leverage = body.leverage

    // Extract wallets
    const embeddedWallet = extractEmbeddedSolanaWallet(authData.user.linked_accounts || [])
    if (!embeddedWallet) {
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
        details: 'Embedded Solana wallet is required for transaction signing',
      }
      return c.json(response, 400)
    }

    let embeddedEthWallet = extractEmbeddedEthWallet(authData.user.linked_accounts || [])
    if (protocol === 'hyperliquid') {
      if (!embeddedEthWallet) {
        const response: SpotPerpTradeErrorResponse = {
          status: 'error',
          message: 'No embedded Ethereum wallet found',
          error: 'Wallet not found',
          details: `Embedded Ethereum wallet is required for Hyperliquid trading`,
        }
        return c.json(response, 400)
      }
      // Verify ETH wallet address
      const verifiedWallet = await getWalletById(embeddedEthWallet.walletId)
      if (verifiedWallet && verifiedWallet.address !== embeddedEthWallet.address) {
        log.warn(`[spot-perp] ETH wallet address mismatch, using verified: ${verifiedWallet.address}`)
        embeddedEthWallet = { ...embeddedEthWallet, address: verifiedWallet.address }
      }
    }

    const walletAddress = embeddedWallet.address
    const walletPubkey = new PublicKey(walletAddress)
    const embeddedWalletId = embeddedWallet.walletId

    // Compute initial split
    const perpNotionalUsd = body.totalUsd / 2
    const perpMarginUsd = perpNotionalUsd / leverage

    log.info(`[spot-perp] Initial split: $${(body.totalUsd / 2).toFixed(2)} spot + $${perpNotionalUsd.toFixed(2)} perp notional ($${perpMarginUsd.toFixed(2)} margin @ ${leverage}x)`)

    // Initialize only the needed perp provider (+ step size lookup)
    arbRegistry = await getInitializedProviders(walletPubkey, embeddedEthWallet?.address, [protocol])

    const marketValidation = await validateMarketExists(body.market, protocol, arbRegistry)
    if (!marketValidation.valid) {
      if (arbRegistry) await arbRegistry.cleanup()
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: marketValidation.error,
        error: 'Market not found',
        details: `Requested market "${body.market}" is not available on ${protocol.toUpperCase()}`,
      }
      return c.json(response, 400)
    }

    const oraclePrice = marketValidation.oraclePrice!
    log.info(`[spot-perp] Market validated: ${marketValidation.symbol}, oracle price: $${oraclePrice.toFixed(4)}`)

    // ========================================
    // Compute matched target size from perp step size
    // ========================================
    // 1. Determine protocol step size (lot size)
    let stepSize: number
    if (protocol === 'pacifica') {
      const pacificaProvider = arbRegistry.getPacificaProvider() as PacificaArbProvider | null
      stepSize = pacificaProvider?.getLotSize(body.market) ?? 0.01
    } else if (protocol === 'aster') {
      const asterProvider = arbRegistry.getAsterProvider() as AsterArbProvider | null
      stepSize = asterProvider?.getLotSize(body.market) ?? 0.01
    } else if (protocol === 'lighter') {
      const lighterProvider = arbRegistry.getLighterProvider() as LighterArbProvider | null
      stepSize = lighterProvider?.getLotSize(body.market) ?? 0.01
    } else if (protocol === '01') {
      const zoProvider = arbRegistry.getZoProvider() as ZoArbProvider | null
      stepSize = zoProvider?.getLotSize(body.market) ?? 0.01
    } else {
      // Hyperliquid
      const hlProvider = arbRegistry.getHyperliquidProvider() as HyperliquidArbProvider | null
      const szDecimals = hlProvider?.getSzDecimals(marketValidation.symbol)
      stepSize = (szDecimals !== null && szDecimals !== undefined) ? Math.pow(10, -szDecimals) : 0.01
    }

    // 2. Compute target size: perpNotionalUsd / oraclePrice, rounded DOWN to step size
    const rawSizeAsset = perpNotionalUsd / oraclePrice
    const targetSizeAsset = Math.floor(rawSizeAsset / stepSize) * stepSize

    // 3. Derive the matched spot buy amount in USDC from the target size
    const matchedSpotBuyUsd = targetSizeAsset * oraclePrice
    const spotBuyUsd = matchedSpotBuyUsd
    const spotBuyAmountSmallest = Math.floor(spotBuyUsd * Math.pow(10, USDC_DECIMALS))

    log.info(`[spot-perp] Size matching: raw=${rawSizeAsset.toFixed(8)}, step=${stepSize}, target=${targetSizeAsset} ${body.market}`)
    log.info(`[spot-perp] Matched spot buy: $${spotBuyUsd.toFixed(2)} (${spotBuyAmountSmallest} USDC smallest units)`)

    const authContext = getAuthorizationContext()
    const privyUserId = authData.user.id || ''

    // ========================================
    // 1. Check USDC balance & get Jupiter quote in parallel
    //    For 01, also pre-bootstrap the session (Privy sign + CreateSession
    //    on cold call) so it overlaps the quote instead of stalling the
    //    perp leg after spot has already settled.
    // ========================================
    log.info(`[spot-perp] Getting Jupiter quote + checking balance in parallel`)

    const [usdcBalance, quoteResponse, zoSession] = await Promise.all([
      getTokenBalance(connection, new PublicKey(USDC_MINT), walletPubkey, USDC_DECIMALS),
      getJupiterSwapQuote({
        inputMint: USDC_MINT,
        outputMint: body.spotTokenMint,
        amount: spotBuyAmountSmallest,
        taker: walletAddress,
        logPrefix: '[spot-perp]',
      }),
      protocol === '01'
        ? getOrCreateZoSession(privyUserId, embeddedWalletId, walletAddress, authContext)
        : Promise.resolve(null),
    ])

    log.info(`[spot-perp] USDC balance: ${usdcBalance ?? 0}`)

    if (!usdcBalance || usdcBalance < spotBuyUsd) {
      if (arbRegistry) await arbRegistry.cleanup()
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: `Insufficient USDC balance. Need $${spotBuyUsd.toFixed(2)}, have $${(usdcBalance ?? 0).toFixed(2)}`,
        error: 'Insufficient balance',
        details: `Wallet ${walletAddress} needs at least ${spotBuyUsd.toFixed(2)} USDC for the spot buy leg`,
      }
      return c.json(response, 400)
    }

    if (!quoteResponse.transaction) {
      if (arbRegistry) await arbRegistry.cleanup()
      const reason = quoteResponse.errorMessage || quoteResponse.errorCode
        ? `Jupiter error: ${quoteResponse.errorMessage || ''} (code: ${quoteResponse.errorCode || 'unknown'})`
        : 'Jupiter did not return a swap transaction. This may indicate insufficient balance, low liquidity, or an unsupported token pair.'
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: reason,
        error: 'Spot buy failed',
        details: reason,
      }
      return c.json(response, 500)
    }

    // ========================================
    // 2. Sign & send spot buy
    // ========================================
    let spotTxnHash: string
    const spotAmount = quoteResponse.outAmount

    try {
      // Jupiter Ultra returns a ready-to-sign transaction with a fresh blockhash.
      // Send it directly — skipping decompile/recompile saves ~2s of ALT + blockhash fetches.
      log.info('[spot-perp] Sending spot buy transaction...')
      const spotSent = await privy
        .wallets()
        .solana()
        .signAndSendTransaction(embeddedWalletId, {
          caip2: SOLANA_CAIP2,
          transaction: quoteResponse.transaction,
          authorization_context: authContext,
        })

      if (!spotSent.hash) {
        throw new Error('Spot transaction hash not returned from Privy')
      }

      spotTxnHash = spotSent.hash
      log.info(`[spot-perp] Spot buy sent: ${spotTxnHash}`)
    } catch (spotError) {
      log.error('[spot-perp] Spot buy failed:', spotError)
      if (arbRegistry) await arbRegistry.cleanup()

      const parsedError = parsePrivyError(spotError)
      const response: SpotPerpTradeErrorResponse = {
        status: 'error',
        message: parsedError.message || 'Spot buy transaction failed',
        error: 'Spot buy failed',
        details: parsedError.details,
      }
      return c.json(response, 500)
    }

    // ========================================
    // 3. Save DB record + execute perp short in parallel
    //    DB insert doesn't block perp execution
    // ========================================
    const dbInsertPromise = db.insert(spotPerpTrades).values({
      userPubkey: walletAddress,
      privyUserId,
      embeddedWalletId,
      market: body.market,
      spotTokenMint: body.spotTokenMint,
      perpProtocol: protocol,
      totalUsd: body.totalUsd,
      spotUsd: spotBuyUsd,
      spotAmount,
      perpMarginUsd,
      perpNotionalUsd,
      perpLeverage: leverage,
      spotTxnHash,
      ethAddress: embeddedEthWallet?.address || null,
    }).returning()

    // ========================================
    // 4. Execute Perp Short (runs in parallel with DB insert)
    // ========================================
    let perpTxnHash: string | undefined
    let perpOrderId: number | undefined
    let perpBundleId: string | undefined
    let perpError: string | undefined

    try {
      if (protocol === 'pacifica') {
        const decimals = Math.max(0, -Math.floor(Math.log10(stepSize)))
        const amount = targetSizeAsset.toFixed(decimals)

        log.info(`[spot-perp] Opening Pacifica perp short: ${amount} ${marketValidation.symbol} @ ${leverage}x`)

        // Set leverage
        const leverageData = { symbol: marketValidation.symbol, leverage: Math.floor(leverage) }
        const { message: leverageMessage, timestamp: leverageTimestamp } = createPacificaPayload('update_leverage', leverageData)
        const leverageSignature = await signMessageWithPrivy(embeddedWalletId, leverageMessage, authContext)
        await setPacificaLeverage({
          account: walletAddress,
          symbol: marketValidation.symbol,
          leverage,
          signature: leverageSignature,
          timestamp: leverageTimestamp,
        })

        // Create market order
        const orderData = {
          symbol: marketValidation.symbol,
          amount,
          side: 'ask',
          slippage_percent: '1.0',
          reduce_only: false,
        }
        const { message, timestamp } = createPacificaPayload('create_market_order', orderData)
        const signature = await signMessageWithPrivy(embeddedWalletId, message, authContext)

        const orderResult = await executePacificaMarketOrder({
          account: walletAddress,
          symbol: marketValidation.symbol,
          amount,
          side: 'ask',
          reduceOnly: false,
          signature,
          timestamp,
        })

        perpTxnHash = `pacifica-order-${orderResult.orderId}`
        perpOrderId = orderResult.orderId

      } else if (protocol === 'hyperliquid') {
        const hyperliquidProvider = arbRegistry!.getHyperliquidProvider()!
        const viemAccount = createHyperliquidViemAccount(
          embeddedEthWallet!.walletId,
          embeddedEthWallet!.address,
          authContext
        )
        hyperliquidProvider.setViemAccount(viemAccount)

        log.info(`[spot-perp] Opening Hyperliquid perp short: ${targetSizeAsset} ${marketValidation.symbol} @ ${leverage}x`)
        const result = await hyperliquidProvider.executeTrade({
          symbol: marketValidation.symbol,
          marginUsd: perpMarginUsd,
          leverage,
          direction: 'short',
          sizeAsset: targetSizeAsset,
        })

        perpTxnHash = `hyperliquid-order-${result.orderId}`
        perpOrderId = result.orderId

      } else if (protocol === 'aster') {
        const asterProvider = arbRegistry!.getAsterProvider() as AsterArbProvider | null
        if (!asterProvider) throw new Error('Aster provider not available')
        if (!embeddedEthWallet) throw new Error('Ethereum wallet required for Aster trading')

        const creds = await getOrCreateAsterApiCredentials(
          privyUserId,
          embeddedEthWallet.address,
          embeddedEthWallet.walletId,
          authContext
        )
        asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)

        log.info(`[spot-perp] Opening Aster perp short: ${targetSizeAsset} ${marketValidation.symbol} @ ${leverage}x`)
        const result = await asterProvider.executeTrade({
          symbol: marketValidation.symbol,
          marginUsd: perpMarginUsd,
          leverage,
          direction: 'short',
          sizeAsset: targetSizeAsset,
        })

        perpTxnHash = `aster-order-${result.orderId}`
        perpOrderId = result.orderId

      } else if (protocol === 'lighter') {
        const lighterProvider = arbRegistry!.getLighterProvider() as LighterArbProvider | null
        if (!lighterProvider) throw new Error('Lighter provider not available')
        if (!embeddedEthWallet) throw new Error('Ethereum wallet required for Lighter trading')

        const creds = await getOrCreateLighterApiCredentials(
          privyUserId,
          embeddedEthWallet.address,
          embeddedEthWallet.walletId,
          authContext
        )
        await lighterProvider.setCredentials(creds)
        lighterProvider.setEthAddress(embeddedEthWallet.address)

        log.info(`[spot-perp] Opening Lighter perp short: ${targetSizeAsset} ${marketValidation.symbol} @ ${leverage}x`)
        const result = await lighterProvider.executeTrade({
          symbol: marketValidation.symbol,
          marginUsd: perpMarginUsd,
          leverage,
          direction: 'short',
          sizeAsset: targetSizeAsset,
        })

        perpTxnHash = `lighter-order-${result.orderId}`
        perpOrderId = result.orderId

      } else if (protocol === '01') {
        const zoProvider = arbRegistry!.getZoProvider() as ZoArbProvider | null
        if (!zoProvider) throw new Error('01 provider not available')
        if (!zoSession) throw new Error('01 session missing — pre-bootstrap failed')
        zoProvider.setSession(zoSession)

        log.info(`[spot-perp] Opening 01 perp short: ${targetSizeAsset} ${marketValidation.symbol} @ ${leverage}x`)
        const result = await runWithZoSessionInvalidation(privyUserId, () => zoProvider.executeTrade({
          symbol: marketValidation.symbol,
          marginUsd: perpMarginUsd,
          leverage,
          direction: 'short',
          sizeAsset: targetSizeAsset,
        }))

        perpTxnHash = `01-order-${result.orderId}`
        perpOrderId = result.orderId
      }

      log.info(`[spot-perp] Perp short completed: ${perpTxnHash}`)
    } catch (error) {
      perpError = error instanceof Error ? error.message : String(error)
      log.error('[spot-perp] Perp short failed:', perpError)
    }

    // Await DB insert — don't let DB failures kill the response
    let tradeId: number = -1
    try {
      const [dbRecord] = await dbInsertPromise
      tradeId = dbRecord.id

      // CRITICAL: Write perpTxnHash immediately so the worker doesn't see a null
      // and incorrectly unwind the spot. Liq price fetch is slow and happens after.
      if (perpTxnHash || perpError) {
        await db.update(spotPerpTrades)
          .set({
            perpTxnHash: perpTxnHash || null,
            perpOrderId: perpOrderId ?? null,
            perpBundleId: perpBundleId || null,
            updatedAt: new Date(),
          })
          .where(eq(spotPerpTrades.id, dbRecord.id))
      }

      // Fetch liquidation price + size from the already-initialized registry
      let perpLiquidationPrice: number | null = null
      let sizeAsset: number | null = targetSizeAsset || null

      if (!perpError && perpTxnHash && arbRegistry) {
        try {
          await new Promise(r => setTimeout(r, 1000))

          const provider = arbRegistry.getProvider(protocol)
          if (provider) {
            const positions = await provider.getPositions(walletPubkey)
            const normalizedSymbol = normalizeMarketSymbol(body.market, protocol)
            const pos = positions.find((p: any) =>
              p.symbol.toUpperCase() === normalizedSymbol.toUpperCase() ||
              p.symbol.toUpperCase() === body.market.toUpperCase()
            )
            if (pos) {
              perpLiquidationPrice = pos.liquidationPrice || null
              sizeAsset = pos.sizeAsset || sizeAsset
              log.info(`[spot-perp] Fetched liq price: ${perpLiquidationPrice}, sizeAsset: ${sizeAsset}`)
            }
          }
        } catch (e) {
          log.warn('[spot-perp] Could not fetch liquidation price:', e)
        }

        // Fallback: compute estimated liq price if live fetch returned null
        if (!perpLiquidationPrice && oraclePrice > 0 && targetSizeAsset > 0) {
          const mmr = 0.05 // conservative default
          perpLiquidationPrice = (perpMarginUsd + oraclePrice * targetSizeAsset) / (targetSizeAsset * (1 + mmr))
          log.info(`[spot-perp] Computed short liq price (estimated, mmr=${mmr}): ${perpLiquidationPrice}`)
        }

        // Second update: add monitoring fields (liq price + size)
        await db.update(spotPerpTrades)
          .set({
            perpLiquidationPrice,
            sizeAsset,
            updatedAt: new Date(),
          })
          .where(eq(spotPerpTrades.id, dbRecord.id))
      }
    } catch (dbError) {
      log.error('[spot-perp] DB operation failed (trade still executed):', dbError instanceof Error ? dbError.message : dbError)
    }

    // Cleanup registry after all work is done
    if (arbRegistry) {
      try { await arbRegistry.cleanup() } catch (e) { log.error('[spot-perp] Cleanup error:', e) }
      arbRegistry = null
    }

    // Return response — trades already executed, always return their data
    const isPartial = !!perpError
    const protocolName = protocol.charAt(0).toUpperCase() + protocol.slice(1)
    const spotMsg = `Spot: bought $${spotBuyUsd.toFixed(2)} worth via Jupiter (tx: ${spotTxnHash.slice(0, 8)}…)`
    const perpMsg = isPartial
      ? `${protocolName} short: failed to open`
      : `${protocolName} short: ${targetSizeAsset} ${marketValidation.symbol} sent (tx: ${perpTxnHash?.slice(0, 8)}…)`

    const response: SpotPerpTradeSuccessResponse = {
      status: isPartial ? 'partial' : 'success',
      message: `${spotMsg}. ${perpMsg}.`,
      data: {
        tradeId,
        totalUsd: body.totalUsd,
        spotUsd: spotBuyUsd,
        spotTxnHash,
        spotAmount,
        perpNotionalUsd,
        perpMarginUsd,
        perpLeverage: leverage,
        perpProtocol: protocol,
        perpMarket: marketValidation.symbol,
        perpTxnHash,
        perpOrderId,
        perpBundleId,
        perpError,
        ethAddress: embeddedEthWallet?.address,
      },
    }

    return c.json(response, isPartial ? 500 : 200)
  } catch (error) {
    log.error('[spot-perp] Error:', error instanceof Error ? error.message : error)
    if (error instanceof Error && error.stack) {
      log.error('[spot-perp] Stack:', error.stack)
    }

    if (arbRegistry) {
      try { await arbRegistry.cleanup() } catch (e) { log.error('[spot-perp] Cleanup error:', e) }
    }

    const errorResponse: SpotPerpTradeErrorResponse = {
      status: 'error',
      message: 'Failed to create spot-perp hedge',
      error: 'Internal server error',
    }
    return c.json(errorResponse, 500)
  }
}
