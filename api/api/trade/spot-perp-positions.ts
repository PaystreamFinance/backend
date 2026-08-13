import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import type {
  SpotPerpPositionsSuccessResponse,
  SpotPerpPositionsErrorResponse,
  SpotPerpPositionInfo,
  SpotPerpProtocol,
} from '../../models/spot-perp'
import { getInitializedProviders } from '@paystream/perps/registry'
import type { ArbProviderRegistry } from '@paystream/perps/registry'
import { normalizePacificaSymbol } from '@paystream/perps/providers/pacifica-provider'
import { normalizeHyperliquidSymbol } from '@paystream/perps/providers/hyperliquid-provider'
import { normalizeAsterSymbol } from '@paystream/perps/providers/aster-provider'
import { normalizeLighterSymbol } from '@paystream/perps/providers/lighter-provider'
import type { LighterArbProvider } from '@paystream/perps/providers/lighter-provider'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../utils/wallet'
import { log } from '../../utils/log'
import { db } from '@paystream/db'
import { spotPerpTrades } from '@paystream/db/schema'
import { and, desc, eq } from 'drizzle-orm'

/**
 * GET /api/trade/spot-perp/positions
 * Fetch active spot-perp trades with live perp position data
 */
export async function spotPerpPositionsHandler(c: Context) {
  let arbRegistry: ArbProviderRegistry | null = null

  try {
    const authData = c.privyUser
    if (!authData) {
      const response: SpotPerpPositionsErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(authData.user.linked_accounts || [])
    if (!embeddedWallet) {
      const response: SpotPerpPositionsErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
      }
      return c.json(response, 400)
    }

    const embeddedEthWallet = extractEmbeddedEthWallet(authData.user.linked_accounts || [])
    const walletPubkey = new PublicKey(embeddedWallet.address)

    // Fetch active trades from DB
    const trades = await db.select().from(spotPerpTrades)
      .where(and(
        eq(spotPerpTrades.userPubkey, embeddedWallet.address),
        eq(spotPerpTrades.active, true),
      ))
      .orderBy(desc(spotPerpTrades.createdAt))

    if (trades.length === 0) {
      const response: SpotPerpPositionsSuccessResponse = {
        status: 'success',
        positions: [],
        totalPerpPnl: 0,
      }
      return c.json(response)
    }

    // Determine which protocols are used
    const usedProtocols = new Set(trades.map(t => t.perpProtocol as SpotPerpProtocol))

    // Initialize only needed providers
    arbRegistry = await getInitializedProviders(walletPubkey, embeddedEthWallet?.address, [...usedProtocols])

    // Set ETH address on Lighter provider for position fetching
    if (usedProtocols.has('lighter') && embeddedEthWallet) {
      const lighterProvider = arbRegistry.getLighterProvider() as LighterArbProvider | null
      if (lighterProvider) lighterProvider.setEthAddress(embeddedEthWallet.address)
    }

    // Fetch live positions in parallel for each used protocol
    const [pacificaPositions, hyperliquidPositions, asterPositions, lighterPositions, zoPositions] = await Promise.all([
      usedProtocols.has('pacifica') && arbRegistry.getProvider('pacifica')
        ? arbRegistry.getProvider('pacifica')!.getPositions(walletPubkey, { includeTriggerPrices: false })
        : [],
      usedProtocols.has('hyperliquid') && arbRegistry.getHyperliquidProvider()
        ? arbRegistry.getHyperliquidProvider()!.getPositions(walletPubkey, { includeTriggerPrices: false })
        : [],
      usedProtocols.has('aster') && arbRegistry.getProvider('aster')
        ? arbRegistry.getProvider('aster')!.getPositions(walletPubkey, { includeTriggerPrices: false })
        : [],
      usedProtocols.has('lighter') && arbRegistry.getLighterProvider()
        ? arbRegistry.getLighterProvider()!.getPositions(walletPubkey, { includeTriggerPrices: false })
        : [],
      usedProtocols.has('01') && arbRegistry.getZoProvider()
        ? arbRegistry.getZoProvider()!.getPositions(walletPubkey, { includeTriggerPrices: false })
        : [],
    ])

    let totalPerpPnl = 0

    // Match DB records with live positions
    const positions: SpotPerpPositionInfo[] = trades.map(trade => {
      let perpPosition: SpotPerpPositionInfo['perpPosition'] = null

      const market = trade.market
      const protocol = trade.perpProtocol as SpotPerpProtocol

      if (protocol === 'pacifica') {
        const normalizedSymbol = normalizePacificaSymbol(market)
        const pos = pacificaPositions.find(
          p => p.symbol.toUpperCase() === normalizedSymbol.toUpperCase() && p.direction === 'short'
        )
        if (pos) {
          perpPosition = { sizeUsd: pos.sizeUsd, pnl: pos.pnl, entryPrice: pos.entryPrice }
          totalPerpPnl += pos.pnl
        }
      } else if (protocol === 'hyperliquid') {
        const normalizedSymbol = normalizeHyperliquidSymbol(market)
        const pos = hyperliquidPositions.find(
          p => p.symbol.toUpperCase() === normalizedSymbol.toUpperCase() && p.direction === 'short'
        )
        if (pos) {
          perpPosition = { sizeUsd: pos.sizeUsd, pnl: pos.pnl, entryPrice: pos.entryPrice }
          totalPerpPnl += pos.pnl
        }
      } else if (protocol === 'aster') {
        const normalizedSymbol = normalizeAsterSymbol(market).replace(/USDC$/, '')
        const pos = asterPositions.find(
          p => p.symbol.toUpperCase() === normalizedSymbol.toUpperCase() && p.direction === 'short'
        )
        if (pos) {
          perpPosition = { sizeUsd: pos.sizeUsd, pnl: pos.pnl, entryPrice: pos.entryPrice }
          totalPerpPnl += pos.pnl
        }
      } else if (protocol === 'lighter') {
        const normalizedSymbol = normalizeLighterSymbol(market).replace(/USDC$/, '')
        const pos = lighterPositions.find(
          p => p.symbol.toUpperCase() === normalizedSymbol.toUpperCase() && p.direction === 'short'
        )
        if (pos) {
          perpPosition = { sizeUsd: pos.sizeUsd, pnl: pos.pnl, entryPrice: pos.entryPrice }
          totalPerpPnl += pos.pnl
        }
      } else if (protocol === '01') {
        // zoProvider emits positions keyed by canonical base symbol, not "BTCUSD".
        const pos = zoPositions.find(
          p => p.symbol.toUpperCase() === market.toUpperCase() && p.direction === 'short'
        )
        if (pos) {
          perpPosition = { sizeUsd: pos.sizeUsd, pnl: pos.pnl, entryPrice: pos.entryPrice }
          totalPerpPnl += pos.pnl
        }
      }

      return {
        tradeId: trade.id,
        market: trade.market,
        spotTokenMint: trade.spotTokenMint,
        perpProtocol: protocol,
        totalUsd: trade.totalUsd,
        spotUsd: trade.spotUsd,
        spotAmount: trade.spotAmount,
        spotTxnHash: trade.spotTxnHash,
        perpMarginUsd: trade.perpMarginUsd,
        perpNotionalUsd: trade.perpNotionalUsd,
        perpLeverage: trade.perpLeverage,
        perpTxnHash: trade.perpTxnHash,
        perpOrderId: trade.perpOrderId,
        createdAt: trade.createdAt.toISOString(),
        perpPosition,
      }
    })

    await arbRegistry.cleanup()
    arbRegistry = null

    const response: SpotPerpPositionsSuccessResponse = {
      status: 'success',
      positions,
      totalPerpPnl: parseFloat(totalPerpPnl.toFixed(2)),
    }

    return c.json(response)
  } catch (error) {
    log.error('[spot-perp/positions] Error:', error instanceof Error ? error.message : error)

    if (arbRegistry) {
      try { await arbRegistry.cleanup() } catch (e) { log.error('[spot-perp/positions] Cleanup error:', e) }
    }

    const errorResponse: SpotPerpPositionsErrorResponse = {
      status: 'error',
      message: 'Failed to fetch positions',
      error: 'Internal server error',
    }
    return c.json(errorResponse, 500)
  }
}
