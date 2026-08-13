import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import type {
  ArbTpSlLookupRequest,
  ArbTpSlLookupResult,
  ArbTpSlLookupSuccessResponse,
  ArbTpSlLookupErrorResponse,
  ArbProtocol,
} from '../../models/arb'
import { isArbProtocol } from '../../models/arb'
import { getInitializedProviders } from '@paystream/perps/registry'
import type { ArbProviderRegistry } from '@paystream/perps/registry'
import { parseHip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import { getStoredApiCredentialsAsync } from '../../clients/arb/aster-auth'
import { applyLighterReadCredentials } from '../../clients/arb/lighter-auth'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../utils/wallet'
import { log } from '../../utils/log'

function validateRequest(body: ArbTpSlLookupRequest): string | null {
  if (!body.positions || !Array.isArray(body.positions) || body.positions.length === 0) {
    return 'positions array is required'
  }

  for (const target of body.positions) {
    if (!isArbProtocol(target.protocol)) {
      return `Invalid protocol: ${String(target.protocol)}`
    }
    if (!target.market) {
      return `Missing market for ${target.protocol}`
    }
  }

  return null
}

/**
 * POST /api/arb/tp-sl
 * Fetch TP/SL trigger prices on-demand for specific protocol+ticker pairs.
 */
export async function tpSlLookupHandler(c: Context) {
  let registry: ArbProviderRegistry | null = null

  try {
    const authData = c.privyUser
    if (!authData) {
      const response: ArbTpSlLookupErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(authData.user.linked_accounts || [])
    if (!embeddedWallet) {
      const response: ArbTpSlLookupErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
      }
      return c.json(response, 400)
    }

    const body = await c.req.json().catch(() => ({})) as ArbTpSlLookupRequest
    const validationError = validateRequest(body)
    if (validationError) {
      const response: ArbTpSlLookupErrorResponse = {
        status: 'error',
        message: validationError,
      }
      return c.json(response, 400)
    }

    const embeddedEthWallet = extractEmbeddedEthWallet(authData.user.linked_accounts || [])
    const walletPubkey = new PublicKey(embeddedWallet.address)
    const neededProtocols = [...new Set(body.positions.map(p => p.protocol))]
    registry = await getInitializedProviders(walletPubkey, embeddedEthWallet?.address, neededProtocols)

    const asterProvider = registry.getAsterProvider()
    const lighterProvider = registry.getLighterProvider()
    const pacificaProvider = registry.getPacificaProvider()
    const hyperliquidProvider = registry.getHyperliquidProvider()
    const zoProvider = registry.getZoProvider()
    const phoenixProvider = registry.getPhoenixProvider()

    if (asterProvider) {
      const creds = await getStoredApiCredentialsAsync(authData.user.id)
      if (creds) asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)
    }

    if (lighterProvider && embeddedEthWallet) {
      await applyLighterReadCredentials(lighterProvider, authData.user.id, embeddedEthWallet.address)
    }

    const positionsByProtocol = new Map<string, Awaited<ReturnType<NonNullable<typeof hyperliquidProvider>['getPositions']>>>()
    const errorsByProtocol = new Map<string, string>()

    const fetches = neededProtocols.map(async (protocol) => {
      try {
        switch (protocol) {
          case 'pacifica':
            if (!pacificaProvider) throw new Error('Pacifica provider not available')
            positionsByProtocol.set(protocol, await pacificaProvider.getPositions(walletPubkey))
            return
          case 'hyperliquid':
            if (!hyperliquidProvider) throw new Error('Hyperliquid provider not available')
            positionsByProtocol.set(protocol, await hyperliquidProvider.getPositions(walletPubkey))
            return
          case 'aster':
            if (!asterProvider) throw new Error('Aster provider not available')
            positionsByProtocol.set(protocol, await asterProvider.getPositions(walletPubkey))
            return
          case 'lighter':
            if (!lighterProvider || !embeddedEthWallet) throw new Error('Lighter provider not available')
            positionsByProtocol.set(protocol, await lighterProvider.getPositionsByEthAddress(embeddedEthWallet.address))
            return
          case '01':
            if (!zoProvider) throw new Error('01 provider not available')
            positionsByProtocol.set(protocol, await zoProvider.getPositions(walletPubkey))
            return
          case 'phoenix':
            if (!phoenixProvider) throw new Error('Phoenix provider not available')
            positionsByProtocol.set(protocol, await phoenixProvider.getPositions(walletPubkey))
            return
          default: {
            const dexName = parseHip3ProtocolId(protocol)
            if (!dexName) throw new Error(`Unsupported protocol: ${protocol}`)
            const provider = registry!.getHip3Provider(dexName)
            if (!provider) throw new Error(`${protocol} provider not available`)
            positionsByProtocol.set(protocol, await provider.getPositions(walletPubkey))
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        errorsByProtocol.set(protocol, message)
        log.warn(`[arb/tp-sl] Failed to fetch positions for ${protocol}: ${message}`)
      }
    })

    await Promise.all(fetches)

    const results: ArbTpSlLookupResult[] = body.positions.map(target => {
      const protocolError = errorsByProtocol.get(target.protocol)
      if (protocolError) {
        return {
          protocol: target.protocol,
          market: target.market,
          status: 'error',
          error: protocolError,
        }
      }

      const positions = positionsByProtocol.get(target.protocol) || []
      const position = positions.find(pos => pos.symbol.toUpperCase() === target.market.toUpperCase())
      if (!position) {
        return {
          protocol: target.protocol,
          market: target.market,
          status: 'not_found',
        }
      }
      return {
        protocol: target.protocol,
        market: target.market,
        status: 'success',
        direction: position.direction,
        triggerPrices: position.triggerPrices,
      }
    })

    await registry.cleanup()
    registry = null

    const hasMisses = results.some(result => result.status !== 'success')
    const response: ArbTpSlLookupSuccessResponse = {
      status: hasMisses ? 'partial' : 'success',
      results,
    }
    return c.json(response)
  } catch (error) {
    log.error('[arb/tp-sl] Error:', error instanceof Error ? error.message : error)

    if (registry) {
      try {
        await registry.cleanup()
      } catch (cleanupError) {
        log.error('[arb/tp-sl] Cleanup error:', cleanupError)
      }
    }

    const response: ArbTpSlLookupErrorResponse = {
      status: 'error',
      message: 'Failed to fetch TP/SL',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    return c.json(response, 500)
  }
}
