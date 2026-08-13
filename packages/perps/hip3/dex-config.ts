/**
 * Curated list of Hyperliquid HIP-3 (builder-deployed) perp dexes that Paystream
 * supports. Adding a new dex requires a code change — this is intentional. We
 * never auto-trust a HIP-3 dex discovered on mainnet until we've verified its
 * collateral token and spot routing.
 *
 * Per Hyperliquid docs, each HIP-3 dex picks its own collateral asset. The
 * perpDexs info endpoint does NOT return it, so we keep a curated map.
 */

/**
 * Collateral tokens used by curated HIP-3 dexes.
 */
export type Hip3Collateral = 'USDC' | 'USDH' | 'USDE' | 'USDT0'

interface Hip3DexSpec {
  collateral: Hip3Collateral
}

export const HIP3_DEXES = {
  xyz: { collateral: 'USDC' },
  flx: { collateral: 'USDH' },
  hyna: { collateral: 'USDE' },
  km: { collateral: 'USDH' },
  cash: { collateral: 'USDT0' },
  para: { collateral: 'USDC' },
} as const satisfies Record<string, Hip3DexSpec>

export type Hip3DexName = keyof typeof HIP3_DEXES

export const HIP3_DEX_NAMES = Object.keys(HIP3_DEXES) as Hip3DexName[]

export type Hip3ProtocolId = `hl:${Hip3DexName}`

export function isSupportedHip3Dex(name: string): name is Hip3DexName {
  return name in HIP3_DEXES
}

export function getHip3Collateral(name: Hip3DexName): Hip3Collateral {
  return HIP3_DEXES[name].collateral
}

export function getHip3ProtocolId(name: Hip3DexName): Hip3ProtocolId {
  return `hl:${name}`
}

/**
 * Parse an `hl:<name>` protocol id back into its dex name. Returns null if the
 * input doesn't match, or if the dex is not in the curated map.
 */
export function parseHip3ProtocolId(protocol: string): Hip3DexName | null {
  if (!protocol.startsWith('hl:')) return null
  const name = protocol.slice(3)
  return isSupportedHip3Dex(name) ? name : null
}

export function isHip3ProtocolId(protocol: string): protocol is Hip3ProtocolId {
  return parseHip3ProtocolId(protocol) !== null
}

/** Strip the `<dex>:` prefix from an HL coin name (e.g. `xyz:XYZ100` → `XYZ100`). */
export function stripHip3Prefix(dexName: string, coin: string): string {
  const prefix = `${dexName}:`
  return coin.startsWith(prefix) ? coin.slice(prefix.length) : coin
}

/**
 * HL deposit/withdraw venue selector. `main` = validator USDC perps (existing
 * flow). A `hl:<dexName>` id routes to the named HIP-3 dex using its curated
 * collateral token.
 */
export type HlVenue = { kind: 'main' } | { kind: 'hip3'; dexName: Hip3DexName; collateral: Hip3Collateral }

/**
 * Parse a venue string (defaults to `main`). Returns null if the string is
 * non-empty, non-`main`, and not a supported `hl:<dexName>` id.
 */
export function parseHlVenue(raw: string | null | undefined): HlVenue | null {
  const venue = raw ?? 'main'
  if (venue === 'main') return { kind: 'main' }
  const dexName = parseHip3ProtocolId(venue)
  if (!dexName) return null
  return { kind: 'hip3', dexName, collateral: getHip3Collateral(dexName) }
}

/** Stable error string listing the curated HIP-3 protocols + `main`. */
export const SUPPORTED_VENUES_MESSAGE =
  `Use "main" or one of the curated HIP-3 protocols (${HIP3_DEX_NAMES.map(n => `hl:${n}`).join(', ')}).`
