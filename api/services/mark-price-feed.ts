import type { WebSocketHandler } from 'bun'
import { log } from '../utils/log'
import { createZoClient, getZoInfoDerived, type ZoClient } from '@paystream/perps/clients/zo-client'
import { baseFromZoSymbol } from '@paystream/perps/providers/zo-provider'
import { getPhoenixHttpClient } from '@paystream/perps/clients/phoenix-client'
import { baseFromPhoenixSymbol } from '@paystream/perps/providers/phoenix-provider'
import type { PhoenixHttpClient } from '@ellipsis-labs/rise'

const WS_RECONNECT_BASE_MS = 5_000
const WS_RECONNECT_MAX_MS = 30_000
const EMIT_THROTTLE_MS = 500 // max 1 publish per 500ms per dex:symbol

// 01 has no mark-price WS stream; fall back to REST polling against /market/{id}/stats.
const ZO_POLL_INTERVAL_MS = 30_000

// Phoenix exposes a mark-price WS, but for v1 we poll the funding overview
// (already used by the provider) on the same cadence as 01.
const PHOENIX_POLL_INTERVAL_MS = 30_000

export interface PriceUpdate {
  dex: string
  symbol: string
  markPrice: number
  ts: number
}

type WsDex = 'hyperliquid' | 'pacifica' | 'lighter' | 'aster'
type DexName = WsDex | '01' | 'phoenix'
type AllDex = DexName

interface DexWsConfig {
  url: string
  subscribeMsg?: unknown
  keepaliveMs?: number
  keepaliveMsg?: string
  onMessage: (msg: any) => void
}

class MarkPriceFeed {
  private prices = new Map<AllDex, Map<string, { markPrice: number; ts: number }>>()
  private lastEmitTs = new Map<string, number>()
  private lastEmittedPrice = new Map<string, number>()
  private dirtyKeys = new Set<string>() // keys with suppressed broadcasts needing flush
  private flushTimer: ReturnType<typeof setInterval> | null = null

  private wsConnections = new Map<WsDex, WebSocket>()
  private keepaliveTimers = new Map<WsDex, ReturnType<typeof setInterval>>()

  private reconnectAttempts: Record<WsDex, number> = {
    hyperliquid: 0, pacifica: 0, lighter: 0, aster: 0,
  }

  private zoClient: ZoClient | null = null
  private zoPollTimer: ReturnType<typeof setInterval> | null = null

  private phoenixClient: PhoenixHttpClient | null = null
  private phoenixPollTimer: ReturnType<typeof setInterval> | null = null

  private started = false
  private server: ReturnType<typeof Bun.serve> | null = null

  start(server: ReturnType<typeof Bun.serve>): void {
    if (this.started) return
    this.started = true
    this.server = server
    log.info('[mark-price-feed] Starting mark price feed')

    this.connectDex('hyperliquid', this.hlConfig())
    this.connectDex('pacifica', this.pacificaConfig())
    this.connectDex('lighter', this.lighterConfig())
    this.connectDex('aster', this.asterConfig())
    this.startZoPolling()
    this.startPhoenixPolling()

    this.flushTimer = setInterval(() => this.flushDirty(), EMIT_THROTTLE_MS)

    log.info('[mark-price-feed] Mark price feed started')
  }

  stop(): void {
    this.started = false
    for (const ws of this.wsConnections.values()) ws.close()
    for (const timer of this.keepaliveTimers.values()) clearInterval(timer)
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.zoPollTimer) clearInterval(this.zoPollTimer)
    if (this.phoenixPollTimer) clearInterval(this.phoenixPollTimer)
    this.wsConnections.clear()
    this.keepaliveTimers.clear()
    this.server = null
    log.info('[mark-price-feed] Stopped')
  }

  getSnapshot(): PriceUpdate[] {
    const result: PriceUpdate[] = []
    for (const [dex, symbols] of this.prices) {
      for (const [symbol, entry] of symbols) {
        result.push({ dex, symbol, markPrice: entry.markPrice, ts: entry.ts })
      }
    }
    return result
  }

  private emitPrice(dex: AllDex, symbol: string, markPrice: number): void {
    const key = `${dex}:${symbol}`
    const now = Date.now()

    // Always update internal state
    if (!this.prices.has(dex)) this.prices.set(dex, new Map())
    this.prices.get(dex)!.set(symbol, { markPrice, ts: now })

    // Throttle broadcasts — mark dirty so flushDirty picks it up later
    const last = this.lastEmitTs.get(key) || 0
    if (now - last < EMIT_THROTTLE_MS) {
      this.dirtyKeys.add(key)
      return
    }

    // Skip if price hasn't changed since last broadcast
    if (this.lastEmittedPrice.get(key) === markPrice) return

    this.dirtyKeys.delete(key)
    this.broadcast(key, dex, symbol, markPrice, now)
  }

  private flushDirty(): void {
    if (this.dirtyKeys.size === 0) return
    const now = Date.now()
    for (const key of this.dirtyKeys) {
      const last = this.lastEmitTs.get(key) || 0
      if (now - last < EMIT_THROTTLE_MS) continue

      const sepIdx = key.indexOf(':')
      const dex = key.slice(0, sepIdx) as AllDex
      const symbol = key.slice(sepIdx + 1)
      const entry = this.prices.get(dex)?.get(symbol)
      if (!entry) { this.dirtyKeys.delete(key); continue }

      if (this.lastEmittedPrice.get(key) === entry.markPrice) {
        this.dirtyKeys.delete(key)
        continue
      }

      this.dirtyKeys.delete(key)
      this.broadcast(key, dex, symbol, entry.markPrice, now)
    }
  }

  private broadcast(key: string, dex: AllDex, symbol: string, markPrice: number, ts: number): void {
    this.lastEmitTs.set(key, ts)
    this.lastEmittedPrice.set(key, markPrice)
    this.server?.publish('prices', JSON.stringify({
      type: 'price', dex, symbol, markPrice, ts,
    }))
  }

  // Generic WS connection with reconnection, keepalive, and lifecycle management
  private connectDex(dex: WsDex, config: DexWsConfig): void {
    try {
      const ws = new WebSocket(config.url)

      ws.onopen = () => {
        log.info(`[mark-price-feed] ${dex} WS connected`)
        this.reconnectAttempts[dex] = 0
        if (config.subscribeMsg) {
          ws.send(JSON.stringify(config.subscribeMsg))
        }
        if (config.keepaliveMs && config.keepaliveMsg !== undefined) {
          this.keepaliveTimers.set(dex, setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(config.keepaliveMsg!)
          }, config.keepaliveMs))
        }
      }

      ws.onmessage = (event) => {
        try {
          config.onMessage(JSON.parse(event.data as string))
        } catch { /* ignore malformed frames */ }
      }

      ws.onerror = (err) => {
        log.warn(`[mark-price-feed] ${dex} WS error: ${err}`)
      }

      ws.onclose = () => {
        log.warn(`[mark-price-feed] ${dex} WS closed`)
        this.wsConnections.delete(dex)
        const timer = this.keepaliveTimers.get(dex)
        if (timer) { clearInterval(timer); this.keepaliveTimers.delete(dex) }
        if (this.started) this.scheduleReconnect(dex, config)
      }

      this.wsConnections.set(dex, ws)
    } catch (e) {
      log.error(`[mark-price-feed] Failed to connect ${dex} WS:`, e)
      if (this.started) this.scheduleReconnect(dex, config)
    }
  }

  // DEX-specific configs (subscription format + message parsing)

  private hlConfig(): DexWsConfig {
    return {
      url: 'wss://api.hyperliquid.xyz/ws',
      subscribeMsg: { method: 'subscribe', subscription: { type: 'allMids' } },
      onMessage: (msg: any) => {
        if (msg.channel === 'allMids' && msg.data?.mids) {
          for (const [coin, priceStr] of Object.entries(msg.data.mids as Record<string, string>)) {
            const price = parseFloat(priceStr)
            if (!isNaN(price) && price > 0) {
              this.emitPrice('hyperliquid', coin.toUpperCase(), price)
            }
          }
        }
      },
    }
  }

  private pacificaConfig(): DexWsConfig {
    return {
      url: 'wss://ws.pacifica.fi/ws',
      subscribeMsg: { method: 'subscribe', params: { source: 'prices' } },
      keepaliveMs: 30_000,
      keepaliveMsg: JSON.stringify({ method: 'ping' }),
      onMessage: (msg: any) => {
        if (msg.channel === 'prices' && Array.isArray(msg.data)) {
          for (const item of msg.data) {
            if (!item.symbol) continue
            const markPrice = parseFloat(item.mark || item.oracle || '0')
            if (!isNaN(markPrice) && markPrice > 0) {
              this.emitPrice('pacifica', item.symbol.toUpperCase(), markPrice)
            }
          }
        }
      },
    }
  }

  private lighterConfig(): DexWsConfig {
    return {
      url: 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true',
      subscribeMsg: { type: 'subscribe', channel: 'market_stats/all' },
      keepaliveMs: 60_000,
      keepaliveMsg: '',
      onMessage: (msg: any) => {
        if (msg.type === 'update/market_stats' && msg.market_stats) {
          const stats = msg.market_stats
          const markPrice = parseFloat(String(stats.mark_price || '0'))
          if (stats.symbol && !isNaN(markPrice) && markPrice > 0) {
            this.emitPrice('lighter', stats.symbol.replace(/-USD$/, '').toUpperCase(), markPrice)
          }
        }
      },
    }
  }

  private asterConfig(): DexWsConfig {
    return {
      url: 'wss://fstream.asterdex.com/ws/!markPrice@arr@1s',
      onMessage: (data: any) => {
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item.s && item.p) {
              const markPrice = parseFloat(item.p)
              if (!isNaN(markPrice) && markPrice > 0) {
                this.emitPrice('aster', item.s.replace(/USDT$/, '').toUpperCase(), markPrice)
              }
            }
          }
        }
      },
    }
  }

  private startZoPolling(): void {
    // Start the interval only after the first poll settles so a slow initial
    // /info fetch can't overlap with a second poll, doubling request load.
    this.pollZoOnce()
      .catch(e => log.warn('[mark-price-feed] 01 initial poll failed:', e))
      .finally(() => {
        if (!this.started) return
        this.zoPollTimer = setInterval(() => {
          this.pollZoOnce().catch(e => log.warn('[mark-price-feed] 01 poll failed:', e))
        }, ZO_POLL_INTERVAL_MS)
      })
  }

  private async pollZoOnce(): Promise<void> {
    if (!this.zoClient) this.zoClient = createZoClient()
    const markets = await getZoInfoDerived(this.zoClient, 'mark-price-feed:markets', info =>
      info.markets.map(m => ({ marketId: m.marketId, baseSymbol: baseFromZoSymbol(m.symbol) })),
    )

    const statsById = await this.zoClient.fetchAllMarketStats(markets.map(m => m.marketId))
    for (const m of markets) {
      const stats = statsById.get(m.marketId)
      if (!stats?.perpStats) continue
      const markPrice = stats.indexPrice ?? stats.perpStats.mark_price ?? 0
      if (markPrice > 0) this.emitPrice('01', m.baseSymbol, markPrice)
    }
  }

  private startPhoenixPolling(): void {
    this.pollPhoenixOnce()
      .catch(e => log.warn('[mark-price-feed] phoenix initial poll failed:', e))
      .finally(() => {
        if (!this.started) return
        this.phoenixPollTimer = setInterval(() => {
          this.pollPhoenixOnce().catch(e => log.warn('[mark-price-feed] phoenix poll failed:', e))
        }, PHOENIX_POLL_INTERVAL_MS)
      })
  }

  private async pollPhoenixOnce(): Promise<void> {
    if (!this.phoenixClient) this.phoenixClient = getPhoenixHttpClient()
    const overview = await this.phoenixClient.funding().getFundingOverview({ perMarketLimit: 1 })
    const latestBySymbol = new Map<string, { markPrice: number; timestampSec: number }>()
    for (const series of overview.series) {
      const base = baseFromPhoenixSymbol(series.symbol)
      const point = series.points[0]
      if (!point) continue
      const markPrice = Number(point.markPrice)
      if (!Number.isFinite(markPrice) || markPrice <= 0) continue
      const existing = latestBySymbol.get(base)
      // Same base may appear under multiple market ids — keep the most recent.
      if (existing && existing.timestampSec >= point.timestamp) continue
      latestBySymbol.set(base, { markPrice, timestampSec: point.timestamp })
    }
    for (const [base, { markPrice }] of latestBySymbol) {
      this.emitPrice('phoenix', base, markPrice)
    }
  }

  private scheduleReconnect(dex: WsDex, config: DexWsConfig): void {
    const attempts = ++this.reconnectAttempts[dex]
    const delay = Math.min(WS_RECONNECT_BASE_MS * Math.pow(2, attempts - 1), WS_RECONNECT_MAX_MS)
    log.info(`[mark-price-feed] Reconnecting ${dex} in ${delay}ms (attempt ${attempts})`)
    setTimeout(() => {
      if (this.started) this.connectDex(dex, config)
    }, delay)
  }
}

const feed = new MarkPriceFeed()

export function createMarkPriceFeed(server: ReturnType<typeof Bun.serve>): MarkPriceFeed {
  feed.start(server)
  return feed
}

export const priceWebSocketHandler: WebSocketHandler<undefined> = {
  open(ws) {
    ws.subscribe('prices')
    ws.send(JSON.stringify({ type: 'snapshot', prices: feed.getSnapshot() }))
  },
  message(ws, message) {
    const text = typeof message === 'string' ? message : message.toString()
    if (text === 'ping') ws.send('pong')
  },
  close() {},
  idleTimeout: 120,
}
