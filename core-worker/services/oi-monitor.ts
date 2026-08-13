import { log } from '../utils/log'
import { canonicalizeSymbol } from '@paystream/perps'
import { createZoClient, getZoInfoDerived, type ZoClient } from '@paystream/perps/clients/zo-client'
import { baseFromZoSymbol } from '@paystream/perps/providers/zo-provider'
import { createPhoenixArbProvider, type PhoenixArbProvider } from '@paystream/perps/providers/phoenix-provider'
import {
  HIP3_DEX_NAMES,
  getHip3ProtocolId,
  stripHip3Prefix,
  type Hip3DexName,
} from '@paystream/perps/hip3/dex-config'

/** How often to snapshot currentOi → previousOi (ms) */
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Minimum notional USD OI required before cascade signal is meaningful.
 * Markets thinner than this (e.g. 01 with ~$200k OI on BTC) produce noisy
 * percentage swings that poison the per-pair worst-of calc. Below this,
 * getOiChange* returns null (fail-open → treated as NORMAL).
 */
const MIN_OI_USD_FOR_CASCADE = 5_000_000

/** REST polling interval for Aster (ms) */
const REST_POLL_INTERVAL_MS = 60 * 1000 // 60 seconds

/** Base reconnect delay for WebSockets (ms) */
const WS_RECONNECT_BASE_MS = 5_000

/** Max reconnect delay (ms) */
const WS_RECONNECT_MAX_MS = 30_000

/** Pacifica WS keepalive interval (ms) */
const PACIFICA_PING_INTERVAL_MS = 30_000

/** Lighter WS keepalive interval (ms) */
const LIGHTER_PING_INTERVAL_MS = 60_000

// Aster API base
const ASTER_API = 'https://fapi.asterdex.com'

// Hyperliquid info endpoint (used for HIP-3 per-dex metaAndAssetCtxs polling)
const HL_INFO_API = 'https://api.hyperliquid.xyz/info'

type OiKey = string // `${symbol}:${dex}`

function oiKey(symbol: string, dex: string): OiKey {
  return `${canonicalizeSymbol(symbol.toUpperCase())}:${dex.toLowerCase()}`
}

class OiMonitor {
  // Open interest stored in base asset units (not USD) so percentage changes
  // reflect real position flow rather than price movement.
  private currentOi = new Map<OiKey, number>()
  private previousOi = new Map<OiKey, number>()
  // Last observed mark/oracle price per key, used to apply a USD threshold
  // when deciding whether a market is deep enough for cascade signal.
  private lastPrice = new Map<OiKey, number>()

  private snapshotTimer: ReturnType<typeof setInterval> | null = null
  private restPollTimer: ReturnType<typeof setInterval> | null = null

  // WebSocket instances
  private hlWs: WebSocket | null = null
  private pacificaWs: WebSocket | null = null
  private lighterWs: WebSocket | null = null

  // Keepalive timers
  private pacificaPingTimer: ReturnType<typeof setInterval> | null = null
  private lighterPingTimer: ReturnType<typeof setInterval> | null = null

  // Reconnect state
  private hlReconnectAttempts = 0
  private pacificaReconnectAttempts = 0
  private lighterReconnectAttempts = 0

  private zoClient: ZoClient | null = null
  private phoenixProvider: PhoenixArbProvider | null = null

  private started = false

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    log.info('[oi-monitor] Starting OI monitor service')

    // Connect WebSockets
    this.connectHyperliquid()
    this.connectPacifica()
    this.connectLighter()

    // Start REST pollers
    await this.pollRest()
    this.restPollTimer = setInterval(() => this.pollRest(), REST_POLL_INTERVAL_MS)

    // Start snapshot timer
    this.snapshotTimer = setInterval(() => this.takeSnapshot(), SNAPSHOT_INTERVAL_MS)

    log.info('[oi-monitor] OI monitor started')
  }

  stop(): void {
    this.started = false
    this.hlWs?.close()
    this.pacificaWs?.close()
    this.lighterWs?.close()
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    if (this.restPollTimer) clearInterval(this.restPollTimer)
    if (this.pacificaPingTimer) clearInterval(this.pacificaPingTimer)
    if (this.lighterPingTimer) clearInterval(this.lighterPingTimer)
    log.info('[oi-monitor] Stopped')
  }

  /**
   * Get OI change ratio for a symbol on a specific dex.
   * Returns null if no data available OR if the market is thinner than
   * MIN_OI_USD_FOR_CASCADE (fail-open — treat as NORMAL).
   */
  getOiChange(symbol: string, dex: string): number | null {
    const key = oiKey(symbol, dex)
    const current = this.currentOi.get(key)
    const previous = this.previousOi.get(key)
    if (current === undefined || previous === undefined || previous === 0) return null

    const price = this.lastPrice.get(key) ?? 0
    if (price > 0 && current * price < MIN_OI_USD_FOR_CASCADE) return null

    return (current - previous) / previous
  }

  /**
   * Get OI change extrapolated to hourly rate.
   * Since snapshots are 5 minutes apart, multiply by 12.
   */
  getOiChangePerHour(symbol: string, dex: string): number | null {
    const change = this.getOiChange(symbol, dex)
    return change !== null ? change * 12 : null
  }

  private takeSnapshot(): void {
    this.previousOi = new Map(this.currentOi)
    log.info(`[oi-monitor] Snapshot taken: ${this.currentOi.size} markets tracked`)
  }

  private recordOi(key: OiKey, oi: number, price: number): void {
    this.currentOi.set(key, oi)
    if (price > 0) this.lastPrice.set(key, price)
  }

  // ---------------------------------------------------------------------------
  // Hyperliquid WebSocket
  // ---------------------------------------------------------------------------

  private connectHyperliquid(): void {
    try {
      const ws = new WebSocket('wss://api.hyperliquid.xyz/ws')

      ws.onopen = () => {
        log.info('[oi-monitor] Hyperliquid WS connected')
        this.hlReconnectAttempts = 0
        // Subscribe to all asset contexts at once
        ws.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'activeAssetData' },
        }))
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string)
          if (data.channel === 'activeAssetData' && data.data) {
            this.handleHyperliquidData(data.data)
          }
        } catch { /* non-JSON or malformed WS frame — ignore */ }
      }

      ws.onerror = (err) => {
        log.warn(`[oi-monitor] Hyperliquid WS error: ${err}`)
      }

      ws.onclose = () => {
        log.warn('[oi-monitor] Hyperliquid WS closed')
        this.hlWs = null
        if (this.started) this.scheduleReconnect('hyperliquid')
      }

      this.hlWs = ws
    } catch (e) {
      log.error('[oi-monitor] Failed to connect Hyperliquid WS:', e)
      if (this.started) this.scheduleReconnect('hyperliquid')
    }
  }

  private handleHyperliquidData(data: any): void {
    // activeAssetData provides per-coin context updates
    // Format: { coin: string, ctx: { openInterest: string, markPx: string, ... } }
    if (data.coin && data.ctx) {
      const oi = parseFloat(data.ctx.openInterest)
      const markPx = parseFloat(data.ctx.markPx)
      if (!isNaN(oi) && !isNaN(markPx) && markPx > 0) {
        this.recordOi(oiKey(data.coin, 'hyperliquid'), oi, markPx)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pacifica WebSocket
  // ---------------------------------------------------------------------------

  private connectPacifica(): void {
    try {
      const ws = new WebSocket('wss://ws.pacifica.fi/ws')

      ws.onopen = () => {
        log.info('[oi-monitor] Pacifica WS connected')
        this.pacificaReconnectAttempts = 0
        ws.send(JSON.stringify({
          method: 'subscribe',
          params: { source: 'prices' },
        }))
        // Keepalive
        this.pacificaPingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ method: 'ping' }))
          }
        }, PACIFICA_PING_INTERVAL_MS)
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string)
          if (data.channel === 'prices' && Array.isArray(data.data)) {
            for (const item of data.data) {
              if (item.symbol && item.open_interest !== undefined) {
                const oi = parseFloat(item.open_interest)
                const markPrice = parseFloat(item.mark || item.oracle || '0')
                if (!isNaN(oi) && oi > 0) {
                  this.recordOi(oiKey(item.symbol, 'pacifica'), oi, markPrice)
                }
              }
            }
          }
        } catch { /* non-JSON or malformed WS frame — ignore */ }
      }

      ws.onerror = (err) => {
        log.warn(`[oi-monitor] Pacifica WS error: ${err}`)
      }

      ws.onclose = () => {
        log.warn('[oi-monitor] Pacifica WS closed')
        this.pacificaWs = null
        if (this.pacificaPingTimer) clearInterval(this.pacificaPingTimer)
        if (this.started) this.scheduleReconnect('pacifica')
      }

      this.pacificaWs = ws
    } catch (e) {
      log.error('[oi-monitor] Failed to connect Pacifica WS:', e)
      if (this.started) this.scheduleReconnect('pacifica')
    }
  }

  // ---------------------------------------------------------------------------
  // Lighter WebSocket
  // ---------------------------------------------------------------------------

  private connectLighter(): void {
    try {
      const ws = new WebSocket('wss://mainnet.zklighter.elliot.ai/stream?readonly=true')

      ws.onopen = () => {
        log.info('[oi-monitor] Lighter WS connected')
        this.lighterReconnectAttempts = 0
        ws.send(JSON.stringify({
          type: 'subscribe',
          channel: 'market_stats/all',
        }))
        // Keepalive — send empty text frame since browser WS API has no ping()
        this.lighterPingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('')
          }
        }, LIGHTER_PING_INTERVAL_MS)
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string)
          if (data.type === 'update/market_stats' && data.market_stats) {
            const stats = data.market_stats
            if (stats.symbol && stats.open_interest !== undefined) {
              const oi = parseFloat(String(stats.open_interest))
              const markPrice = parseFloat(String(stats.mark_price || '0'))
              if (!isNaN(oi) && markPrice > 0) {
                // Normalize symbol: "BTC-USD" → "BTC"
                const symbol = stats.symbol.replace(/-USD$/, '')
                this.recordOi(oiKey(symbol, 'lighter'), oi, markPrice)
              }
            }
          }
        } catch { /* non-JSON or malformed WS frame — ignore */ }
      }

      ws.onerror = (err) => {
        log.warn(`[oi-monitor] Lighter WS error: ${err}`)
      }

      ws.onclose = () => {
        log.warn('[oi-monitor] Lighter WS closed')
        this.lighterWs = null
        if (this.lighterPingTimer) clearInterval(this.lighterPingTimer)
        if (this.started) this.scheduleReconnect('lighter')
      }

      this.lighterWs = ws
    } catch (e) {
      log.error('[oi-monitor] Failed to connect Lighter WS:', e)
      if (this.started) this.scheduleReconnect('lighter')
    }
  }

  // ---------------------------------------------------------------------------
  // REST Pollers (Aster)
  // ---------------------------------------------------------------------------

  private async pollRest(): Promise<void> {
    await Promise.all([this.pollAster(), this.pollZo(), this.pollHip3(), this.pollPhoenix()])
  }

  private async pollPhoenix(): Promise<void> {
    try {
      if (!this.phoenixProvider) this.phoenixProvider = createPhoenixArbProvider()
      const snapshot = await this.phoenixProvider.getOpenInterestSnapshot()
      for (const [base, { openInterest, markPrice }] of snapshot) {
        this.recordOi(oiKey(base, 'phoenix'), openInterest, markPrice)
      }
    } catch (e) {
      log.warn('[oi-monitor] Phoenix REST poll error:', e)
    }
  }

  private async pollHip3(): Promise<void> {
    await Promise.all(HIP3_DEX_NAMES.map(dexName => this.pollHip3Dex(dexName)))
  }

  private async pollHip3Dex(dexName: Hip3DexName): Promise<void> {
    try {
      const response = await fetch(HL_INFO_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: dexName }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return

      const [meta, assetCtxs] = await response.json() as [
        { universe: { name: string }[] },
        { openInterest?: string; oraclePx?: string }[],
      ]

      const dexId = getHip3ProtocolId(dexName)
      for (let i = 0; i < meta.universe.length; i++) {
        const ctx = assetCtxs[i]
        if (!ctx?.openInterest || !ctx.oraclePx) continue
        const oi = parseFloat(ctx.openInterest)
        const price = parseFloat(ctx.oraclePx)
        if (!isFinite(oi) || !isFinite(price) || price <= 0) continue
        const symbol = stripHip3Prefix(dexName, meta.universe[i].name)
        this.recordOi(oiKey(symbol, dexId), oi, price)
      }
    } catch (e) {
      log.warn(`[oi-monitor] HIP-3 ${dexName} REST poll error:`, e)
    }
  }

  private async pollZo(): Promise<void> {
    try {
      if (!this.zoClient) this.zoClient = createZoClient()
      const markets = await getZoInfoDerived(this.zoClient, 'oi-monitor:markets', info =>
        info.markets.map(m => ({ marketId: m.marketId, baseSymbol: baseFromZoSymbol(m.symbol) })),
      )

      const statsById = await this.zoClient.fetchAllMarketStats(markets.map(m => m.marketId))
      for (const m of markets) {
        const stats = statsById.get(m.marketId)
        if (!stats?.perpStats) continue
        const oi = stats.perpStats.open_interest
        const price = stats.indexPrice ?? stats.perpStats.mark_price ?? 0
        if (oi > 0 && price > 0) {
          this.recordOi(oiKey(m.baseSymbol, '01'), oi, price)
        }
      }
    } catch (e) {
      log.warn('[oi-monitor] 01 REST poll error:', e)
    }
  }

  private async pollAster(): Promise<void> {
    try {
      const asterKeys = Array.from(this.currentOi.keys())
        .filter(k => k.endsWith(':aster'))
        .map(k => k.split(':')[0])

      const symbolsToFetch = asterKeys.length > 0
        ? asterKeys
        : ['BTC', 'ETH', 'SOL']

      await Promise.all(symbolsToFetch.map(async (symbol) => {
        try {
          const [oiResponse, priceResponse] = await Promise.all([
            fetch(`${ASTER_API}/fapi/v3/openInterest?symbol=${symbol}USDT`, {
              signal: AbortSignal.timeout(5_000),
            }),
            fetch(`${ASTER_API}/fapi/v3/ticker/price?symbol=${symbol}USDT`, {
              signal: AbortSignal.timeout(5_000),
            }),
          ])
          if (!oiResponse.ok || !priceResponse.ok) return

          const oiData: { openInterest: string } = await oiResponse.json()
          const priceData: { price: string } = await priceResponse.json()

          const oi = parseFloat(oiData.openInterest)
          const price = parseFloat(priceData.price)
          if (!isNaN(oi) && !isNaN(price) && price > 0) {
            this.recordOi(oiKey(symbol, 'aster'), oi, price)
          }
        } catch { /* individual symbol failure — continue with others */ }
      }))
    } catch (e) {
      log.warn('[oi-monitor] Aster REST poll error:', e)
    }
  }

  // ---------------------------------------------------------------------------
  // Reconnection
  // ---------------------------------------------------------------------------

  private scheduleReconnect(dex: 'hyperliquid' | 'pacifica' | 'lighter'): void {
    let attempts: number
    switch (dex) {
      case 'hyperliquid': attempts = ++this.hlReconnectAttempts; break
      case 'pacifica': attempts = ++this.pacificaReconnectAttempts; break
      case 'lighter': attempts = ++this.lighterReconnectAttempts; break
    }

    const delay = Math.min(WS_RECONNECT_BASE_MS * Math.pow(2, attempts - 1), WS_RECONNECT_MAX_MS)
    log.info(`[oi-monitor] Reconnecting ${dex} in ${delay}ms (attempt ${attempts})`)

    setTimeout(() => {
      if (!this.started) return
      switch (dex) {
        case 'hyperliquid': this.connectHyperliquid(); break
        case 'pacifica': this.connectPacifica(); break
        case 'lighter': this.connectLighter(); break
      }
    }, delay)
  }
}

export const oiMonitor = new OiMonitor()
