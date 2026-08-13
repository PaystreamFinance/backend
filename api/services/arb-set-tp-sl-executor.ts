import { PublicKey } from '@solana/web3.js'
import type { ArbProtocol, TpSlType } from '../models/arb'
import { TP_SL_TYPES } from '../models/arb'
import { getInitializedProviders } from '@paystream/perps/registry'
import { HyperliquidArbProvider } from '@paystream/perps/providers/hyperliquid-provider'
import { Hip3HyperliquidArbProvider } from '@paystream/perps/providers/hip3-hyperliquid-provider'
import { PacificaArbProvider } from '@paystream/perps/providers/pacifica-provider'
import { AsterArbProvider } from '@paystream/perps/providers/aster-provider'
import { LighterArbProvider } from '@paystream/perps/providers/lighter-provider'
import { PhoenixArbProvider } from '@paystream/perps/providers/phoenix-provider'
import { parseHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import type { IArbProvider } from '@paystream/perps/types'
import { getOrCreateAsterApiCredentials } from '../clients/arb/aster-auth'
import { getOrCreateLighterApiCredentials } from '../clients/arb/lighter-auth'
import { getOrCreateZoSession, runWithZoSessionInvalidation } from '../clients/arb/zo-auth'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../utils/wallet'
import { privy, getAuthorizationContext, signMessageWithPrivy, createHyperliquidViemAccount } from '../clients/privy'
import { connection } from '../clients/solana'
import { serializeTransactionForPrivy } from '../utils/transaction'
import { SOLANA_CAIP2 } from '../utils/constants'
import { log } from '../utils/log'

export interface ArbSetTpSlParams {
  privyUserId: string
  market: string
  protocol: ArbProtocol
  type: TpSlType
  /** Absolute trigger price. Mutually exclusive with triggerPricePercent. */
  triggerPrice?: number
  /** Entry-price-relative %, always positive (0 < pct < 100). Sign is inferred from type + position direction. */
  triggerPricePercent?: number
}

export interface ArbSetTpSlResult {
  success: boolean
  direction?: 'long' | 'short'
  /** Resolved absolute trigger price placed on the exchange. */
  triggerPrice?: number
  /** Entry price used to resolve a percent-based request. */
  entryPrice?: number
  error?: string
}

function computeTriggerFromPercent(
  entryPrice: number,
  percent: number,
  type: TpSlType,
  direction: 'long' | 'short',
): number {
  const frac = percent / 100
  const priceShouldRise = (direction === 'long') === (type === 'tp')
  return priceShouldRise ? entryPrice * (1 + frac) : entryPrice * (1 - frac)
}

interface ResolveTriggerArgs {
  provider: IArbProvider
  wallet: PublicKey
  market: string
  type: TpSlType
  triggerPrice: number | undefined
  triggerPricePercent: number | undefined
}

// Note: percent mode fetches positions here AND the provider's setTakeProfit/setStopLoss
// fetches them again internally to determine the close direction. Eliminating the
// duplicate fetch would require threading a pre-fetched position through 5 providers'
// public APIs; accepted for now since percent TP/SL is called per user action, not in a
// hot polling loop.
async function resolveTriggerPrice(
  args: ResolveTriggerArgs,
): Promise<{ triggerPrice: number; entryPrice?: number; direction?: 'long' | 'short' }> {
  const { provider, wallet, market, type, triggerPrice, triggerPricePercent } = args
  if (typeof triggerPrice === 'number' && triggerPrice > 0) {
    return { triggerPrice }
  }
  if (typeof triggerPricePercent !== 'number') {
    throw new Error('Either triggerPrice or triggerPricePercent must be provided')
  }

  const positions = await provider.getPositions(wallet)
  const normalized = market.toUpperCase()
  const position = positions.find(p => p.symbol.toUpperCase() === normalized)
  if (!position) {
    throw new Error(`No open position for ${market} on ${provider.name} to resolve percent-based TP/SL`)
  }
  if (!(position.entryPrice > 0)) {
    throw new Error(`Invalid entry price for ${market} on ${provider.name}: ${position.entryPrice}`)
  }

  const resolved = computeTriggerFromPercent(
    position.entryPrice,
    triggerPricePercent,
    type,
    position.direction,
  )
  if (!(resolved > 0)) {
    throw new Error(`Resolved trigger price is non-positive (${resolved}) for ${market}`)
  }
  return { triggerPrice: resolved, entryPrice: position.entryPrice, direction: position.direction }
}

/**
 * Set a take-profit or stop-loss on a single position for a specific protocol.
 * Shared by the user-facing /api/arb/set-tp-sl handler and the internal worker
 * endpoint used by the ride-to-liquidation flow (which always passes type='sl').
 */
export async function executeArbSetTpSl(params: ArbSetTpSlParams): Promise<ArbSetTpSlResult> {
  const { privyUserId, market, protocol, type, triggerPrice, triggerPricePercent } = params

  if (!market) {
    return { success: false, error: 'Invalid market' }
  }
  const hasPrice = typeof triggerPrice === 'number'
  const hasPercent = typeof triggerPricePercent === 'number'
  if (hasPrice === hasPercent) {
    return { success: false, error: 'Exactly one of triggerPrice or triggerPricePercent must be provided' }
  }
  if (hasPrice && (triggerPrice as number) <= 0) {
    return { success: false, error: 'Invalid triggerPrice' }
  }
  if (hasPercent) {
    const pct = triggerPricePercent as number
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      return { success: false, error: 'triggerPricePercent must be between 0 and 100 (exclusive)' }
    }
  }
  if (!TP_SL_TYPES.includes(type)) {
    return { success: false, error: `Invalid type: ${type}` }
  }

  let registry = null

  try {
    const user = await privy.users()._get(privyUserId)
    if (!user) {
      return { success: false, error: 'User not found in Privy' }
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(user.linked_accounts || [])
    if (!embeddedWallet) {
      return { success: false, error: 'No embedded Solana wallet found' }
    }

    const embeddedEthWallet = extractEmbeddedEthWallet(user.linked_accounts || [])

    const walletPubkey = new PublicKey(embeddedWallet.address)
    registry = await getInitializedProviders(walletPubkey, embeddedEthWallet?.address, [protocol])

    const authContext = getAuthorizationContext()

    // Hyperliquid providers ignore the Solana wallet for position fetches; the
    // active viem account set by setViemAccount() drives auth.
    const HL_PLACEHOLDER_WALLET = new PublicKey('11111111111111111111111111111111')

    // HIP-3 protocols route through the same signing path as main Hyperliquid
    // (ETH wallet, EIP-712 via Privy) — the provider just scopes itself to
    // one HIP-3 dex.
    const hip3DexName = parseHip3ProtocolId(protocol)
    if (hip3DexName) {
      const hip3Provider = registry.getHip3Provider(hip3DexName) as Hip3HyperliquidArbProvider | null
      if (!hip3Provider) throw new Error(`HIP-3 provider ${protocol} not available`)
      if (!embeddedEthWallet) throw new Error('Ethereum wallet required for HIP-3 Hyperliquid')

      const viemAccount = createHyperliquidViemAccount(
        embeddedEthWallet.walletId,
        embeddedEthWallet.address,
        authContext,
      )
      hip3Provider.setViemAccount(viemAccount)

      const resolved = await resolveTriggerPrice({
        provider: hip3Provider, wallet: HL_PLACEHOLDER_WALLET,
        market, type, triggerPrice, triggerPricePercent,
      })
      const result = type === 'tp'
        ? await hip3Provider.setTakeProfit(market, resolved.triggerPrice)
        : await hip3Provider.setStopLoss(market, resolved.triggerPrice)
      return {
        success: true,
        direction: result.direction,
        triggerPrice: resolved.triggerPrice,
        entryPrice: resolved.entryPrice,
      }
    }

    switch (protocol) {
      case 'hyperliquid': {
        const hlProvider = registry.getHyperliquidProvider() as HyperliquidArbProvider | null
        if (!hlProvider) throw new Error('Hyperliquid provider not available')
        if (!embeddedEthWallet) throw new Error('Ethereum wallet required for Hyperliquid')

        const viemAccount = createHyperliquidViemAccount(
          embeddedEthWallet.walletId,
          embeddedEthWallet.address,
          authContext,
        )
        hlProvider.setViemAccount(viemAccount)

        const resolved = await resolveTriggerPrice({
          provider: hlProvider, wallet: HL_PLACEHOLDER_WALLET,
          market, type, triggerPrice, triggerPricePercent,
        })
        const result = type === 'tp'
          ? await hlProvider.setTakeProfit(market, resolved.triggerPrice)
          : await hlProvider.setStopLoss(market, resolved.triggerPrice)
        return {
          success: true,
          direction: result.direction,
          triggerPrice: resolved.triggerPrice,
          entryPrice: resolved.entryPrice,
        }
      }

      case 'pacifica': {
        const pacificaProvider = registry.getPacificaProvider() as PacificaArbProvider | null
        if (!pacificaProvider) throw new Error('Pacifica provider not available')

        const resolved = await resolveTriggerPrice({
          provider: pacificaProvider, wallet: walletPubkey,
          market, type, triggerPrice, triggerPricePercent,
        })
        const signFn = (message: string) => signMessageWithPrivy(embeddedWallet.walletId, message, authContext)
        const result = type === 'tp'
          ? await pacificaProvider.setTakeProfit(market, resolved.triggerPrice, signFn)
          : await pacificaProvider.setStopLoss(market, resolved.triggerPrice, signFn)
        return {
          success: true,
          direction: result.direction,
          triggerPrice: resolved.triggerPrice,
          entryPrice: resolved.entryPrice,
        }
      }

      case 'aster': {
        const asterProvider = registry.getAsterProvider() as AsterArbProvider | null
        if (!asterProvider) throw new Error('Aster provider not available')

        const creds = await getOrCreateAsterApiCredentials(
          privyUserId,
          embeddedWallet.address,
          embeddedWallet.walletId,
          authContext,
        )
        asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)

        const resolved = await resolveTriggerPrice({
          provider: asterProvider, wallet: walletPubkey,
          market, type, triggerPrice, triggerPricePercent,
        })
        const result = type === 'tp'
          ? await asterProvider.setTakeProfit(market, resolved.triggerPrice)
          : await asterProvider.setStopLoss(market, resolved.triggerPrice)
        return {
          success: true,
          direction: result.direction,
          triggerPrice: resolved.triggerPrice,
          entryPrice: resolved.entryPrice,
        }
      }

      case 'lighter': {
        const lighterProvider = registry.getLighterProvider() as LighterArbProvider | null
        if (!lighterProvider) throw new Error('Lighter provider not available')
        if (!embeddedEthWallet) throw new Error('Ethereum wallet required for Lighter')

        const creds = await getOrCreateLighterApiCredentials(
          privyUserId,
          embeddedEthWallet.address,
          embeddedEthWallet.walletId,
          authContext,
        )
        await lighterProvider.setCredentials(creds)
        lighterProvider.setEthAddress(embeddedEthWallet.address)

        const resolved = await resolveTriggerPrice({
          provider: lighterProvider, wallet: walletPubkey,
          market, type, triggerPrice, triggerPricePercent,
        })
        const result = type === 'tp'
          ? await lighterProvider.setTakeProfit(market, resolved.triggerPrice)
          : await lighterProvider.setStopLoss(market, resolved.triggerPrice)
        return {
          success: true,
          direction: result.direction,
          triggerPrice: resolved.triggerPrice,
          entryPrice: resolved.entryPrice,
        }
      }

      case '01': {
        const zoProvider = registry.getZoProvider()
        if (!zoProvider) throw new Error('01 provider not available')

        const session = await getOrCreateZoSession(
          privyUserId,
          embeddedWallet.walletId,
          embeddedWallet.address,
          authContext,
        )
        zoProvider.setSession(session)

        const result = await runWithZoSessionInvalidation(privyUserId, async () => {
          const resolved = await resolveTriggerPrice({
            provider: zoProvider, wallet: walletPubkey,
            market, type, triggerPrice, triggerPricePercent,
          })
          const r = type === 'tp'
            ? await zoProvider.setTakeProfit(market, resolved.triggerPrice)
            : await zoProvider.setStopLoss(market, resolved.triggerPrice)
          return { ...r, triggerPrice: resolved.triggerPrice, entryPrice: resolved.entryPrice }
        })
        return {
          success: true,
          direction: result.direction,
          triggerPrice: result.triggerPrice,
          entryPrice: result.entryPrice,
        }
      }

      case 'phoenix': {
        const phoenixProvider = registry.getPhoenixProvider() as PhoenixArbProvider | null
        if (!phoenixProvider) throw new Error('Phoenix provider not available')
        const resolved = await resolveTriggerPrice({
          provider: phoenixProvider, wallet: walletPubkey,
          market, type, triggerPrice, triggerPricePercent,
        })

        const built = type === 'tp'
          ? await phoenixProvider.buildSetTakeProfitTransaction({
              symbol: market,
              triggerPrice: resolved.triggerPrice,
              authority: embeddedWallet.address,
            })
          : await phoenixProvider.buildSetStopLossTransaction({
              symbol: market,
              triggerPrice: resolved.triggerPrice,
              authority: embeddedWallet.address,
            })

        const { blockhash } = await connection.getLatestBlockhash('finalized')
        built.transaction.recentBlockhash = blockhash

        const serializedTx = serializeTransactionForPrivy(built.transaction)
        const result = await privy.wallets().solana().signAndSendTransaction(
          embeddedWallet.walletId,
          {
            caip2: SOLANA_CAIP2,
            transaction: serializedTx,
            authorization_context: authContext,
          },
        )
        if (!result.hash) throw new Error('Phoenix TP/SL transaction hash not returned from Privy')

        return {
          success: true,
          direction: built.direction,
          triggerPrice: resolved.triggerPrice,
          entryPrice: resolved.entryPrice,
        }
      }

      default: {
        return { success: false, error: `Unsupported protocol: ${protocol}` }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    log.error(`[arb-set-tp-sl-executor] Failed for ${type} ${protocol}/${market}: ${errorMsg}`)
    return { success: false, error: errorMsg }
  } finally {
    if (registry) {
      try {
        await registry.cleanup()
      } catch (cleanupError) {
        log.error('[arb-set-tp-sl-executor] Cleanup error:', cleanupError)
      }
    }
  }
}
