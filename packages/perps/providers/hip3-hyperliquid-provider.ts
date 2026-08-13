import type { PublicKey } from '@solana/web3.js'
import type {
  ArbMarketInfo,
  ArbPosition,
  FundingPaymentsResult,
  GetPositionsOptions,
} from '../types'
import {
  formatHyperliquidPrice,
  formatHyperliquidSize,
} from '../clients/hyperliquid-client'
import { HyperliquidArbProvider, buildTriggerMap } from './hyperliquid-provider'
import { stripHip3Prefix } from '../hip3/dex-config'
import type { Hip3DexName, Hip3Collateral, Hip3ProtocolId } from '../hip3/dex-config'
import { nextHourMs } from '../funding-rates/utils'
import { log } from '../logger'

/**
 * Single HIP-3 dex provider — one instance per curated HIP-3 dex. Reuses the
 * main {@link HyperliquidArbProvider}, scoping all info reads to `dex:<name>`
 * and encoding asset ids as `100_000 + perpDexIndex * 10_000 + indexInMeta`.
 * External symbols strip the `<dex>:` prefix that HL uses on HIP-3 coin names.
 */
export class Hip3HyperliquidArbProvider extends HyperliquidArbProvider {
  readonly dexName: Hip3DexName
  // 1-based index in the perpDexs array (index 0 is null = main).
  readonly perpDexIndex: number
  readonly collateral: Hip3Collateral
  readonly protocolId: Hip3ProtocolId

  constructor(config: {
    dexName: Hip3DexName
    perpDexIndex: number
    collateral: Hip3Collateral
    ethAddress: string
    testnet?: boolean
  }) {
    super(config.ethAddress, config.testnet ?? false)
    this.dexName = config.dexName
    this.perpDexIndex = config.perpDexIndex
    this.collateral = config.collateral
    this.protocolId = `hl:${config.dexName}`
    this.name = this.protocolId
  }

  protected encodeAssetId(indexInMeta: number): number {
    return 100_000 + this.perpDexIndex * 10_000 + indexInMeta
  }

  protected stripPrefix(coin: string): string {
    return stripHip3Prefix(this.dexName, coin)
  }

  protected normalizeSymbol(symbol: string): string {
    const stripped = this.stripPrefix(symbol).toUpperCase()
    return stripped.replace(/-PERP$/, '').replace(/-USD$/, '')
  }

  /** Prefixed HL coin name for a stripped symbol (e.g. `XYZ100` → `xyz:XYZ100`). */
  getPrefixedCoin(symbol: string): string {
    return `${this.dexName}:${this.normalizeSymbol(symbol)}`
  }

  protected async refreshMarketData(): Promise<void> {
    const now = Date.now()
    if (this.marketCache.timestamp > 0 && now - this.marketCache.timestamp < this.CACHE_TTL_MS) {
      return
    }

    try {
      const [[meta, assetCtxs], rawMids] = await Promise.all([
        this.client.getMetaAndAssetCtxs(this.dexName),
        this.client.getAllMids(this.dexName),
      ])

      this.assetIndexMap.clear()
      this.assetMetaMap.clear()

      for (let i = 0; i < meta.universe.length; i++) {
        const asset = meta.universe[i]
        const symbol = this.stripPrefix(asset.name).toUpperCase()
        const encoded = this.encodeAssetId(i)
        this.assetIndexMap.set(symbol, encoded)
        this.assetMetaMap.set(encoded, {
          szDecimals: asset.szDecimals,
          maxLeverage: asset.maxLeverage,
        })
      }

      const mids: Record<string, string> = {}
      for (const [coin, price] of Object.entries(rawMids)) {
        mids[this.stripPrefix(coin).toUpperCase()] = price
      }

      // HIP-3 doesn't expose predictedFundings per-dex.
      this.marketCache = { meta, mids, assetCtxs, predictedFundings: new Map(), timestamp: now }
    } catch (error) {
      log.error(`[hl-arb:${this.dexName}] Error refreshing market data:`, error)
    }
  }

  async getMarketInfo(symbol: string): Promise<ArbMarketInfo | null> {
    if (!this.isInitialized) {
      throw new Error(`${this.protocolId} provider not initialized`)
    }
    await this.refreshMarketData()

    const normalized = this.normalizeSymbol(symbol)
    const encoded = this.assetIndexMap.get(normalized)
    if (encoded === undefined) return null

    const localIndex = encoded - 100_000 - this.perpDexIndex * 10_000
    const priceStr = this.marketCache.mids[normalized]
    if (!priceStr) return null

    const oraclePrice = parseFloat(priceStr)
    const assetMeta = this.assetMetaMap.get(encoded)
    const assetCtx = this.marketCache.assetCtxs[localIndex]

    // HIP-3 funding interval assumed 1h; verify per-dex if needed.
    const fundingIntervalHours = 1
    let fundingRate: number | undefined
    let fundingRateApr: number | undefined
    if (assetCtx?.funding) {
      fundingRate = parseFloat(assetCtx.funding)
      fundingRateApr = fundingRate * (24 / fundingIntervalHours) * 365
    }

    let openInterest: { long: number; short: number } | undefined
    if (assetCtx?.openInterest) {
      const totalOiNative = parseFloat(assetCtx.openInterest)
      openInterest = { long: totalOiNative * oraclePrice, short: 0 }
    }

    const markPrice = assetCtx?.markPx ? parseFloat(assetCtx.markPx) : undefined
    const indexPrice = assetCtx?.oraclePx ? parseFloat(assetCtx.oraclePx) : undefined

    return {
      symbol: normalized,
      oraclePrice,
      markPrice,
      indexPrice,
      fundingRate,
      fundingRateApr,
      openInterest,
      maxLeverage: assetMeta?.maxLeverage,
      fundingIntervalHours,
      nextFundingTime: nextHourMs(),
    }
  }

  async getAllMarkets(): Promise<ArbMarketInfo[]> {
    if (!this.isInitialized) {
      throw new Error(`${this.protocolId} provider not initialized`)
    }
    await this.refreshMarketData()

    const markets: ArbMarketInfo[] = []
    if (!this.marketCache.meta) return markets

    const fundingIntervalHours = 1
    const nft = nextHourMs()

    for (let i = 0; i < this.marketCache.meta.universe.length; i++) {
      const asset = this.marketCache.meta.universe[i]
      const symbol = this.stripPrefix(asset.name).toUpperCase()
      const priceStr = this.marketCache.mids[symbol]
      const assetCtx = this.marketCache.assetCtxs[i]
      if (!priceStr) continue

      const oraclePrice = parseFloat(priceStr)
      let fundingRate: number | undefined
      let fundingRateApr: number | undefined
      let openInterest: { long: number; short: number } | undefined

      if (assetCtx?.funding) {
        fundingRate = parseFloat(assetCtx.funding)
        fundingRateApr = fundingRate * (24 / fundingIntervalHours) * 365
      }
      if (assetCtx?.openInterest) {
        const totalOiNative = parseFloat(assetCtx.openInterest)
        openInterest = { long: totalOiNative * oraclePrice, short: 0 }
      }

      const markPrice = assetCtx?.markPx ? parseFloat(assetCtx.markPx) : undefined
      const indexPrice = assetCtx?.oraclePx ? parseFloat(assetCtx.oraclePx) : undefined

      markets.push({
        symbol,
        oraclePrice,
        markPrice,
        indexPrice,
        fundingRate,
        fundingRateApr,
        openInterest,
        maxLeverage: asset.maxLeverage,
        fundingIntervalHours,
        nextFundingTime: nft,
      })
    }

    return markets
  }

  /** Positions for this HIP-3 dex only (scoped by `dex` on clearinghouseState). */
  async getPositions(_wallet: PublicKey, options?: GetPositionsOptions): Promise<ArbPosition[]> {
    return this.fetchPositions(options)
  }

  private async fetchPositions(options?: GetPositionsOptions): Promise<ArbPosition[]> {
    if (!this.isInitialized) return []
    try {
      const includeTriggerPrices = options?.includeTriggerPrices !== false
      const statePromise = this.client.getClearinghouseState(undefined, this.dexName)
      const openOrdersPromise = includeTriggerPrices
        ? this.client.getFrontendOpenOrders(undefined, this.dexName).catch(err => {
            log.warn(`[hl-arb:${this.dexName}] Failed to fetch open orders for TP/SL:`, err instanceof Error ? err.message : err)
            return []
          })
        : Promise.resolve([])
      const [state, openOrders] = await Promise.all([statePromise, openOrdersPromise])
      // HL's per-dex `frontendOpenOrders` may strip the `<dex>:` prefix from
      // `order.coin` while clearinghouseState keeps it on `pos.coin`. Strip
      // both sides so the map keys line up.
      const normalizedOrders = includeTriggerPrices
        ? openOrders.map(o => ({ ...o, coin: this.stripPrefix(o.coin) }))
        : []
      const triggerMap = includeTriggerPrices ? buildTriggerMap(normalizedOrders) : new Map<string, { tp?: number; sl?: number }>()

      const positions: ArbPosition[] = []
      for (const assetPos of state.assetPositions) {
        const pos = assetPos.position
        const szi = parseFloat(pos.szi)
        if (szi === 0) continue

        const direction: 'long' | 'short' = szi > 0 ? 'long' : 'short'
        const sizeAsset = Math.abs(szi)
        const entryPrice = parseFloat(pos.entryPx)
        const sizeUsd = parseFloat(pos.positionValue)
        const pricePnl = parseFloat(pos.unrealizedPnl)
        const fundingSinceOpen = parseFloat(pos.cumFunding?.sinceOpen || '0')
        const fundingIncome = -fundingSinceOpen
        const pnl = pricePnl + fundingIncome
        const margin = parseFloat(pos.marginUsed)
        const leverage = pos.leverage?.value || (margin > 0 ? sizeUsd / margin : 1)
        const liquidationPrice = pos.liquidationPx ? parseFloat(pos.liquidationPx) : undefined

        const triggerPrices = triggerMap.get(`${this.stripPrefix(pos.coin)}:${direction}`)

        positions.push({
          symbol: this.stripPrefix(pos.coin).toUpperCase(),
          direction,
          sizeUsd,
          sizeAsset,
          pnl,
          unrealizedPnl: pricePnl,
          fundingIncome,
          entryPrice,
          leverage,
          margin,
          liquidationPrice,
          triggerPrices,
        })
      }
      return positions
    } catch (error) {
      log.error(`[hl-arb:${this.dexName}] Error fetching positions:`, error)
      return []
    }
  }

  async executeClose(
    symbol: string,
    direction: 'long' | 'short',
  ): Promise<{ orderId: number; success: boolean; avgPrice?: string }> {
    const normalized = this.normalizeSymbol(symbol)
    const encoded = this.getAssetIndex(symbol)
    if (encoded === null) throw new Error(`Market ${symbol} not found on ${this.protocolId}`)

    const positions = await this.fetchPositions()
    const position = positions.find(p => p.symbol.toUpperCase() === normalized && p.direction === direction)
    if (!position) throw new Error(`No ${direction} position found for ${normalized} on ${this.protocolId}`)

    const assetMeta = this.getAssetMeta(encoded)
    if (!assetMeta) throw new Error(`Asset metadata not found for ${symbol}`)

    await this.refreshMarketData()
    const priceStr = this.marketCache.mids[normalized]
    if (!priceStr) throw new Error(`Price not available for ${normalized}`)
    const currentPrice = parseFloat(priceStr)

    const formattedSize = formatHyperliquidSize(Math.abs(position.sizeAsset), assetMeta.szDecimals)
    const slippageMultiplier = direction === 'long' ? 0.99 : 1.01
    const limitPrice = currentPrice * slippageMultiplier
    const formattedPrice = formatHyperliquidPrice(limitPrice, assetMeta.szDecimals)

    log.info(`[hl-arb:${this.dexName}] Closing ${direction} ${normalized}: size=${formattedSize}, px=${formattedPrice}`)

    const result = await this.client.placeOrder({
      asset: encoded,
      isBuy: direction === 'short',
      limitPx: formattedPrice,
      sz: formattedSize,
      reduceOnly: true,
      orderType: { limit: { tif: 'Ioc' } },
    })

    if (result.status !== 'ok') throw new Error(`Close failed: ${JSON.stringify(result)}`)
    const orderStatus = result.response?.data?.statuses?.[0]
    if (orderStatus?.error) throw new Error(`Close error: ${orderStatus.error}`)
    const filled = orderStatus?.filled
    const resting = orderStatus?.resting
    return { orderId: filled?.oid || resting?.oid || 0, success: true, avgPrice: filled?.avgPx }
  }

  async setTakeProfit(symbol: string, triggerPrice: number) {
    return this.setTriggerOrder('tp', symbol, triggerPrice)
  }
  async setStopLoss(symbol: string, triggerPrice: number) {
    return this.setTriggerOrder('sl', symbol, triggerPrice)
  }

  private async setTriggerOrder(
    type: 'tp' | 'sl',
    symbol: string,
    triggerPrice: number,
  ): Promise<{ success: boolean; direction: 'long' | 'short' }> {
    const normalized = this.normalizeSymbol(symbol)
    const encoded = this.getAssetIndex(symbol)
    if (encoded === null) throw new Error(`Market ${symbol} not found on ${this.protocolId}`)

    const positions = await this.fetchPositions()
    const position = positions.find(p => p.symbol.toUpperCase() === normalized)
    if (!position) throw new Error(`No position found for ${normalized} on ${this.protocolId}`)

    const assetMeta = this.getAssetMeta(encoded)
    if (!assetMeta) throw new Error(`Asset metadata not found for ${symbol}`)

    const formattedSize = formatHyperliquidSize(Math.abs(position.sizeAsset), assetMeta.szDecimals)
    const formattedTriggerPx = formatHyperliquidPrice(triggerPrice, assetMeta.szDecimals)

    const result = await this.client.placeOrder(
      {
        asset: encoded,
        isBuy: position.direction === 'short',
        limitPx: formattedTriggerPx,
        sz: formattedSize,
        reduceOnly: true,
        orderType: { trigger: { triggerPx: formattedTriggerPx, isMarket: true, tpsl: type } },
      },
      'positionTpsl',
    )

    if (result.status !== 'ok') throw new Error(`${type.toUpperCase()} failed: ${JSON.stringify(result)}`)
    const orderStatus = result.response?.data?.statuses?.[0]
    if (orderStatus?.error && orderStatus.error !== 'waitingForTrigger') {
      throw new Error(`${type.toUpperCase()} error: ${orderStatus.error}`)
    }
    return { success: true, direction: position.direction }
  }

  /** Historical funding payments — scoped to this HIP-3 dex. */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPaymentsResult> {
    if (!this.isInitialized) return { payments: [], truncated: false }
    try {
      const entries = await this.client.getUserFunding(undefined, startTime, endTime, this.dexName)
      const payments = entries.map(entry => ({
        symbol: this.stripPrefix(entry.delta.coin).toUpperCase(),
        amount: parseFloat(entry.delta.usdc),
        rate: parseFloat(entry.delta.fundingRate),
        timestamp: entry.time,
        direction: parseFloat(entry.delta.szi) > 0 ? ('long' as const) : ('short' as const),
      }))
      return { payments, truncated: false }
    } catch (error) {
      log.error(`[hl-arb:${this.dexName}] Error fetching funding payments:`, error)
      throw error
    }
  }

  /** Account snapshot (value/margin) for this HIP-3 dex. */
  async getAccountInfo() {
    try {
      const state = await this.client.getClearinghouseState(undefined, this.dexName)
      return {
        accountValue: parseFloat(state.crossMarginSummary.accountValue),
        totalMarginUsed: parseFloat(state.crossMarginSummary.totalMarginUsed),
        withdrawable: parseFloat(state.withdrawable),
      }
    } catch (error) {
      log.error(`[hl-arb:${this.dexName}] Error fetching account info:`, error)
      return null
    }
  }

}

export function createHip3HyperliquidArbProvider(config: {
  dexName: Hip3DexName
  perpDexIndex: number
  collateral: Hip3Collateral
  ethAddress: string
  testnet?: boolean
}): Hip3HyperliquidArbProvider {
  return new Hip3HyperliquidArbProvider(config)
}
