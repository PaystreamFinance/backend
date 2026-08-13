import { createHmac } from 'crypto'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'
import { log } from '../utils/log'
import { canonicalizeSymbol } from '../funding-rates/utils'
import { db } from '@paystream/db'
import { exchangeApiKeys } from '@paystream/db/schema'
import { eq, and } from 'drizzle-orm'
import {
  createZoClient,
  getZoInfoDerived,
  type ZoMarketSpec,
  type ZoUserInfo,
  type ZoAccountInfo,
  type ZoMarketStats,
} from '@paystream/perps/clients/zo-client'
import { parseHip3ProtocolId, stripHip3Prefix, getHip3ProtocolId, type Hip3DexName } from '@paystream/perps/hip3/dex-config'
import { PublicKey } from '@solana/web3.js'
import { createPhoenixArbProvider } from '@paystream/perps/providers/phoenix-provider'

export interface LivePerpPosition {
  protocol: string
  symbol: string
  sizeAsset: number
  direction: 'long' | 'short'
  notionalUsd: number
  leverage: number
  entryPrice: number
  liquidationPrice: number | null
  unrealizedPnl: number
  marginUsd: number
}

/** Result of a position fetch — distinguishes API errors from genuine "no position" */
export type PositionFetchResult =
  | { ok: true; position: LivePerpPosition | null }
  | { ok: false; error: string }

const HL_API = 'https://api.hyperliquid.xyz/info'
const PACIFICA_API = process.env.PACIFICA_API_BASE || 'https://api.pacifica.fi'
const ASTER_API = 'https://fapi.asterdex.com'
const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai'
const ZO_API = 'https://zo-mainnet.n1.xyz'

export async function fetchLivePosition(
  protocol: string,
  symbol: string,
  ethAddress: string | null,
  userPubkey: string,
  privyUserId?: string,
): Promise<PositionFetchResult> {
  try {
    const hip3Dex = parseHip3ProtocolId(protocol)
    if (hip3Dex) {
      return await fetchHyperliquidPosition(symbol, ethAddress, hip3Dex)
    }
    switch (protocol.toLowerCase()) {
      case 'hyperliquid':
        return await fetchHyperliquidPosition(symbol, ethAddress)
      case 'pacifica':
        return await fetchPacificaPosition(symbol, userPubkey)
      case 'aster':
        return await fetchAsterPosition(symbol, privyUserId)
      case 'lighter':
        return await fetchLighterPosition(symbol, ethAddress)
      case '01':
        return await fetchZoPosition(symbol, userPubkey)
      case 'phoenix':
        return await fetchPhoenixPosition(symbol, userPubkey)
      default:
        return { ok: false, error: `Unknown protocol: ${protocol}` }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error(`[position-fetcher] ${protocol} ${symbol}: ${msg}`)
    return { ok: false, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Hyperliquid
// ---------------------------------------------------------------------------

interface HLAssetPosition {
  position: {
    coin: string
    szi: string
    entryPx: string
    leverage: { value: string }
    liquidationPx: string | null
    unrealizedPnl: string
    positionValue: string
    marginUsed: string
  }
}

async function fetchHyperliquidPosition(
  symbol: string,
  ethAddress: string | null,
  hip3Dex?: Hip3DexName,
): Promise<PositionFetchResult> {
  const scope = hip3Dex ? `hl:${hip3Dex}` : 'Hyperliquid'
  if (!ethAddress) {
    return { ok: false, error: `No ethAddress for ${scope}` }
  }

  const body: Record<string, unknown> = { type: 'clearinghouseState', user: ethAddress }
  if (hip3Dex) body.dex = hip3Dex

  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    return { ok: false, error: `HL HTTP ${res.status}${hip3Dex ? ` (dex=${hip3Dex})` : ''}` }
  }

  const data = await res.json() as { assetPositions?: HLAssetPosition[] }
  if (!data.assetPositions) {
    return { ok: false, error: `HL response missing assetPositions${hip3Dex ? ` (dex=${hip3Dex})` : ''}` }
  }

  const upper = symbol.toUpperCase()
  const match = data.assetPositions.find(ap => {
    const raw = hip3Dex ? stripHip3Prefix(hip3Dex, ap.position.coin) : ap.position.coin
    const coin = raw.toUpperCase()
    return coin === upper || canonicalizeSymbol(coin) === upper
  })

  if (!match) {
    return { ok: true, position: null }
  }

  const pos = match.position
  const szi = parseFloat(pos.szi)
  const entryPrice = parseFloat(pos.entryPx)
  const leverage = parseFloat(pos.leverage.value)
  const notional = Math.abs(parseFloat(pos.positionValue))
  const liqPx = pos.liquidationPx ? parseFloat(pos.liquidationPx) : null

  return {
    ok: true,
    position: {
      protocol: hip3Dex ? getHip3ProtocolId(hip3Dex) : 'hyperliquid',
      symbol: upper,
      sizeAsset: Math.abs(szi),
      direction: szi > 0 ? 'long' : 'short',
      notionalUsd: notional,
      leverage,
      entryPrice,
      liquidationPrice: liqPx && liqPx > 0 ? liqPx : null,
      unrealizedPnl: parseFloat(pos.unrealizedPnl),
      marginUsd: parseFloat(pos.marginUsed),
    },
  }
}

// ---------------------------------------------------------------------------
// Pacifica
// ---------------------------------------------------------------------------

interface PacificaPositionEntry {
  symbol: string
  side: string
  amount: string
  entry_price: string
  margin: string
  funding: string
  unrealized_pnl?: string
  notional?: string
  leverage?: string
  liquidation_price?: string
}

async function fetchPacificaPosition(
  symbol: string,
  userPubkey: string,
): Promise<PositionFetchResult> {
  if (!userPubkey) {
    return { ok: false, error: 'No userPubkey for Pacifica' }
  }

  const res = await fetch(
    `${PACIFICA_API}/api/v1/positions?account=${userPubkey}`,
    { signal: AbortSignal.timeout(10_000) },
  )

  if (!res.ok) {
    return { ok: false, error: `Pacifica HTTP ${res.status}` }
  }

  const raw = await res.json() as any
  const data = raw?.data ?? raw
  const positions = Array.isArray(data) ? data : []

  if (positions.length === 0) {
    return { ok: true, position: null }
  }

  const upper = symbol.toUpperCase()
  const match = (positions as PacificaPositionEntry[]).find(p => {
    const posSymbol = p.symbol.toUpperCase()
    return posSymbol === upper
      || canonicalizeSymbol(posSymbol) === upper
      || posSymbol === 'K' + upper.replace('1000', '')
  })

  if (!match) {
    return { ok: true, position: null }
  }

  const amount = parseFloat(match.amount)
  const side = match.side?.toLowerCase()
  const entryPrice = parseFloat(match.entry_price)
  const margin = parseFloat(match.margin) || 0

  let currentPrice = entryPrice
  try {
    const priceRes = await fetch(`${PACIFICA_API}/api/v1/prices`, { signal: AbortSignal.timeout(5_000) })
    if (priceRes.ok) {
      const priceData = await priceRes.json() as any
      const prices = priceData?.data ?? priceData
      const priceEntry = prices?.[match.symbol.toUpperCase()]
      if (priceEntry) {
        currentPrice = parseFloat(priceEntry.oracle || priceEntry.mark) || entryPrice
      }
    }
  } catch {}

  const sizeAsset = Math.abs(amount)
  const notional = sizeAsset * currentPrice
  const leverage = margin > 0 ? notional / margin : 1
  const direction: 'long' | 'short' = (side === 'short' || side === 'ask') ? 'short' : 'long'

  let liquidationPrice: number | null = null
  if (match.liquidation_price) {
    const parsed = parseFloat(match.liquidation_price)
    if (parsed > 0) liquidationPrice = parsed
  }

  return {
    ok: true,
    position: {
      protocol: 'pacifica',
      symbol: upper,
      sizeAsset,
      direction,
      notionalUsd: notional,
      leverage,
      entryPrice,
      liquidationPrice,
      unrealizedPnl: match.unrealized_pnl ? parseFloat(match.unrealized_pnl) : 0,
      marginUsd: margin,
    },
  }
}

// ---------------------------------------------------------------------------
// Aster (signed endpoint — HMAC-SHA256 with user's API credentials)
// ---------------------------------------------------------------------------

interface AsterPositionRisk {
  symbol: string
  positionAmt: string
  entryPrice: string
  markPrice: string
  unRealizedProfit: string
  liquidationPrice: string
  leverage: string
  isolatedMargin: string
  notional: string
}

function asterSignParams(params: Record<string, any>, apiSecret: string): Record<string, string> {
  const timestamp = Date.now()
  const allParams: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    allParams[key] = String(value)
  }
  allParams['recvWindow'] = '50000'
  allParams['timestamp'] = String(timestamp)

  const queryString = Object.entries(allParams).map(([k, v]) => `${k}=${v}`).join('&')
  const signature = createHmac('sha256', apiSecret).update(queryString).digest('hex')

  return { ...allParams, signature }
}

async function fetchAsterPosition(
  symbol: string,
  privyUserId?: string,
): Promise<PositionFetchResult> {
  if (!privyUserId) {
    return { ok: false, error: 'No privyUserId for Aster credential lookup' }
  }

  // Load API credentials from DB
  const [row] = await db.select({ credentials: exchangeApiKeys.credentials })
    .from(exchangeApiKeys)
    .where(and(
      eq(exchangeApiKeys.privyUserId, privyUserId),
      eq(exchangeApiKeys.exchange, 'aster'),
      eq(exchangeApiKeys.isActive, true),
    ))
    .limit(1)

  if (!row?.credentials) {
    return { ok: false, error: 'No Aster API credentials found' }
  }

  const parsed = typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials
  const { apiKey, apiSecret } = parsed as { apiKey: string; apiSecret: string }
  if (!apiKey || !apiSecret) {
    return { ok: false, error: 'Invalid Aster API credentials' }
  }

  const signedParams = asterSignParams({}, apiSecret)
  const url = new URL(`${ASTER_API}/fapi/v2/positionRisk`)
  for (const [key, value] of Object.entries(signedParams)) {
    url.searchParams.set(key, value)
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-MBX-APIKEY': apiKey,
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    return { ok: false, error: `Aster HTTP ${res.status}` }
  }

  const positions = await res.json() as AsterPositionRisk[]

  const upper = symbol.toUpperCase()
  const match = positions.find(p => {
    const base = p.symbol.replace(/USDT$/, '').toUpperCase()
    return base === upper || canonicalizeSymbol(base) === upper
  })

  if (!match || parseFloat(match.positionAmt) === 0) {
    return { ok: true, position: null }
  }

  const posAmt = parseFloat(match.positionAmt)
  const entryPrice = parseFloat(match.entryPrice)
  const markPrice = parseFloat(match.markPrice)
  const leverage = parseFloat(match.leverage)
  const sizeAsset = Math.abs(posAmt)
  const notional = Math.abs(parseFloat(match.notional))
  const isolatedMargin = parseFloat(match.isolatedMargin)
  const margin = isolatedMargin > 0 ? isolatedMargin : notional / leverage
  const liqPrice = parseFloat(match.liquidationPrice)

  return {
    ok: true,
    position: {
      protocol: 'aster',
      symbol: upper,
      sizeAsset,
      direction: posAmt > 0 ? 'long' : 'short',
      notionalUsd: notional,
      leverage,
      entryPrice,
      liquidationPrice: liqPrice > 0 ? liqPrice : null,
      unrealizedPnl: parseFloat(match.unRealizedProfit),
      marginUsd: margin,
    },
  }
}

// ---------------------------------------------------------------------------
// Lighter (public endpoint — no auth)
// ---------------------------------------------------------------------------

interface LighterPositionData {
  market_id: number
  symbol: string
  sign: number
  position: string
  avg_entry_price: string
  position_value: string
  unrealized_pnl: string
  initial_margin_fraction: string
  allocated_margin: string
  liquidation_price: string
  total_funding_paid_out?: string
}

/** EIP-55 checksum an Ethereum address (avoids viem dependency) */
function checksumAddress(address: string): string {
  const addr = address.toLowerCase().replace('0x', '')
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(addr)))
  let checksummed = '0x'
  for (let i = 0; i < addr.length; i++) {
    checksummed += parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i]
  }
  return checksummed
}

/** Cache orderBookDetails symbol map (market_id → symbol) */
let lighterSymbolCache: Map<number, string> | null = null
let lighterSymbolCacheTimestamp = 0
const LIGHTER_SYMBOL_CACHE_TTL_MS = 60_000

async function getLighterSymbolMap(): Promise<Map<number, string>> {
  const now = Date.now()
  if (lighterSymbolCache && (now - lighterSymbolCacheTimestamp) < LIGHTER_SYMBOL_CACHE_TTL_MS) {
    return lighterSymbolCache
  }

  const res = await fetch(`${LIGHTER_API}/api/v1/orderBookDetails`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Lighter orderBookDetails HTTP ${res.status}`)

  const data = await res.json() as { order_book_details: { market_id: number; symbol: string; market_type: string }[] }
  const map = new Map<number, string>()
  for (const d of data.order_book_details || []) {
    if (d.market_type === 'perp') {
      map.set(d.market_id, d.symbol.toUpperCase())
    }
  }

  lighterSymbolCache = map
  lighterSymbolCacheTimestamp = now
  return map
}

async function fetchLighterPosition(
  symbol: string,
  ethAddress: string | null,
): Promise<PositionFetchResult> {
  if (!ethAddress) {
    return { ok: false, error: 'No ethAddress for Lighter' }
  }

  const checksummed = checksumAddress(ethAddress)

  const res = await fetch(
    `${LIGHTER_API}/api/v1/account?by=l1_address&value=${checksummed}`,
    { signal: AbortSignal.timeout(10_000) },
  )

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (text.includes('account not found')) {
      return { ok: true, position: null }
    }
    return { ok: false, error: `Lighter HTTP ${res.status}` }
  }

  const data = await res.json() as { accounts?: { positions?: LighterPositionData[] }[] }
  const account = data.accounts?.[0]
  if (!account) {
    return { ok: true, position: null }
  }

  const positions = account.positions || []
  if (positions.length === 0) {
    return { ok: true, position: null }
  }

  // Resolve symbol from market_id via cached orderBookDetails
  const symbolMap = await getLighterSymbolMap()

  const upper = symbol.toUpperCase()
  const match = positions.find(p => {
    const posSymbol = (p.symbol || symbolMap.get(p.market_id) || '').toUpperCase()
    return posSymbol === upper || canonicalizeSymbol(posSymbol) === upper
  })

  if (!match || parseFloat(match.position) === 0) {
    return { ok: true, position: null }
  }

  const size = parseFloat(match.position)
  const direction: 'long' | 'short' = match.sign >= 0 ? 'long' : 'short'
  const entryPrice = parseFloat(match.avg_entry_price)
  const positionValue = Math.abs(parseFloat(match.position_value))
  const unrealizedPnl = parseFloat(match.unrealized_pnl)
  const imf = parseFloat(match.initial_margin_fraction)
  const leverage = imf > 0 ? 100 / imf : 1
  const allocatedMargin = parseFloat(match.allocated_margin)
  const margin = allocatedMargin > 0 ? allocatedMargin : positionValue / leverage
  const liqPrice = parseFloat(match.liquidation_price)

  return {
    ok: true,
    position: {
      protocol: 'lighter',
      symbol: upper,
      sizeAsset: size,
      direction,
      notionalUsd: positionValue,
      leverage,
      entryPrice,
      liquidationPrice: liqPrice > 0 ? liqPrice : null,
      unrealizedPnl,
      marginUsd: margin,
    },
  }
}

// ---------------------------------------------------------------------------
// 01 (Nord / zo) — public read via /user and /account; needs a marketId map
// ---------------------------------------------------------------------------

const zoClient = createZoClient()

async function getZoSymbolMap(): Promise<Map<string, ZoMarketSpec>> {
  return getZoInfoDerived(zoClient, 'position-fetcher:symbolMap', info => {
    const map = new Map<string, ZoMarketSpec>()
    for (const m of info.markets || []) {
      map.set(m.symbol.toUpperCase().replace(/USD$/, ''), m)
    }
    return map
  })
}

async function fetchZoPosition(
  symbol: string,
  userPubkey: string,
): Promise<PositionFetchResult> {
  if (!userPubkey) {
    return { ok: false, error: 'No userPubkey for 01' }
  }

  const upper = symbol.toUpperCase()
  const canonical = canonicalizeSymbol(upper)

  const symbolMap = await getZoSymbolMap()
  const spec = symbolMap.get(canonical) ?? symbolMap.get(upper)
  if (!spec) {
    return { ok: true, position: null }
  }

  const userRes = await fetch(`${ZO_API}/user/${userPubkey}`, { signal: AbortSignal.timeout(10_000) })
  if (userRes.status === 404) {
    return { ok: true, position: null }
  }
  if (!userRes.ok) {
    return { ok: false, error: `01 /user HTTP ${userRes.status}` }
  }
  const userData = await userRes.json() as ZoUserInfo
  if (!userData.accountIds?.length) {
    return { ok: true, position: null }
  }

  const accountId = userData.accountIds[0]
  const [accountRes, statsRes] = await Promise.all([
    fetch(`${ZO_API}/account/${accountId}`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${ZO_API}/market/${spec.marketId}/stats`, { signal: AbortSignal.timeout(10_000) }).catch(() => null),
  ])

  if (!accountRes.ok) {
    return { ok: false, error: `01 /account HTTP ${accountRes.status}` }
  }

  const account = await accountRes.json() as ZoAccountInfo
  const match = account.positions?.find(p => p.marketId === spec.marketId && p.perp)
  if (!match || !match.perp) {
    return { ok: true, position: null }
  }

  if (!Number.isFinite(match.perp.baseSize) || match.perp.baseSize === 0) {
    return { ok: true, position: null }
  }
  const sizeAsset = Math.abs(match.perp.baseSize)
  const direction: 'long' | 'short' = match.perp.isLong ? 'long' : 'short'
  const entryPrice = match.perp.price ?? 0

  let mark = entryPrice
  if (statsRes?.ok) {
    const stats = await statsRes.json() as ZoMarketStats
    mark = stats.indexPrice ?? stats.perpStats?.mark_price ?? entryPrice
  }
  const notional = sizeAsset * mark
  const unrealized = direction === 'long'
    ? (mark - entryPrice) * sizeAsset
    : (entryPrice - mark) * sizeAsset

  // 01's /account payload doesn't expose per-position margin. Approximate
  // using the initial-margin fraction (imf) — callers that need exact margin
  // should refine via /account.margins when that surface is wired up.
  const marginUsd = spec.imf > 0 ? notional * spec.imf : 0
  const leverage = marginUsd > 0 ? notional / marginUsd : 0

  return {
    ok: true,
    position: {
      protocol: '01',
      symbol: upper,
      sizeAsset,
      direction,
      notionalUsd: notional,
      leverage,
      entryPrice,
      liquidationPrice: null,
      unrealizedPnl: unrealized,
      marginUsd,
    },
  }
}

// ---------------------------------------------------------------------------
// Phoenix (phoenix.trade) — isolated subaccounts per asset, read via provider
// ---------------------------------------------------------------------------

async function fetchPhoenixPosition(
  symbol: string,
  userPubkey: string,
): Promise<PositionFetchResult> {
  if (!userPubkey) {
    return { ok: false, error: 'No userPubkey for Phoenix' }
  }

  let walletPk: PublicKey
  try {
    walletPk = new PublicKey(userPubkey)
  } catch {
    return { ok: false, error: `Invalid Phoenix wallet pubkey: ${userPubkey}` }
  }

  const provider = createPhoenixArbProvider({ walletPubkey: walletPk })
  const positions = await provider.getPositions(walletPk)
  if (positions.length === 0) {
    return { ok: true, position: null }
  }

  const upper = symbol.toUpperCase()
  const canonical = canonicalizeSymbol(upper)
  const match = positions.find(p => {
    const pos = p.symbol.toUpperCase()
    return pos === upper || canonicalizeSymbol(pos) === canonical
  })

  if (!match || match.sizeAsset === 0) {
    return { ok: true, position: null }
  }

  return {
    ok: true,
    position: {
      protocol: 'phoenix',
      symbol: upper,
      sizeAsset: match.sizeAsset,
      direction: match.direction,
      notionalUsd: match.sizeUsd,
      leverage: match.leverage,
      entryPrice: match.entryPrice,
      liquidationPrice: match.liquidationPrice && match.liquidationPrice > 0 ? match.liquidationPrice : null,
      unrealizedPnl: match.unrealizedPnl,
      marginUsd: match.margin,
    },
  }
}
