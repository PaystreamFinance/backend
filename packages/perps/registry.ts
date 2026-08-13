import { PublicKey } from '@solana/web3.js'
import type { IArbProvider } from './types'
import { PacificaArbProvider, createPacificaArbProvider } from './providers/pacifica-provider'
import { HyperliquidArbProvider, createHyperliquidArbProvider } from './providers/hyperliquid-provider'
import { Hip3HyperliquidArbProvider, createHip3HyperliquidArbProvider } from './providers/hip3-hyperliquid-provider'
import { AsterArbProvider, createAsterArbProvider } from './providers/aster-provider'
import { LighterArbProvider, createLighterArbProvider } from './providers/lighter-provider'
import { ZoArbProvider, createZoArbProvider } from './providers/zo-provider'
import { PhoenixArbProvider, createPhoenixArbProvider } from './providers/phoenix-provider'
import { createHyperliquidClient } from './clients/hyperliquid-client'
import { HIP3_DEX_NAMES, getHip3Collateral, isSupportedHip3Dex, getHip3ProtocolId } from './hip3/dex-config'
import type { Hip3DexName } from './hip3/dex-config'
import { DUMMY_KEYPAIR, DUMMY_ETH_ADDRESS } from './constants'
import { log } from './logger'

// Global cached registry for market data (read-only, no user wallet needed)
let globalMarketDataRegistry: ArbProviderRegistry | null = null
let globalRegistryInitPromise: Promise<ArbProviderRegistry> | null = null

// Cached market data
interface CachedMarketData {
  pacificaMarkets: any[]
  hyperliquidMarkets: any[]
  asterMarkets: any[]
  lighterMarkets: any[]
  zoMarkets: any[]
  phoenixMarkets: any[]
  hip3Markets: Record<string, any[]>  // keyed by Hip3DexName, but widened to string for API ergonomics
  timestamp: number
}
let cachedMarketData: CachedMarketData | null = null
const MARKET_CACHE_TTL_MS = 30_000 // 30 seconds
let marketDataRefreshPromise: Promise<CachedMarketData> | null = null

// perpDex indexes are stable once assigned; cache module-wide so each registry
// init doesn't pay a HL round-trip even when the caller doesn't use HIP-3.
let hip3IndexCache: { map: Map<Hip3DexName, number>; timestamp: number } | null = null
const HIP3_INDEX_TTL_MS = 60 * 60_000 // 1h
let hip3IndexFetchPromise: Promise<Map<Hip3DexName, number>> | null = null

function cloneCachedMarketData(data: CachedMarketData): CachedMarketData {
  return {
    pacificaMarkets: data.pacificaMarkets,
    hyperliquidMarkets: data.hyperliquidMarkets,
    asterMarkets: data.asterMarkets,
    lighterMarkets: data.lighterMarkets,
    zoMarkets: data.zoMarkets,
    phoenixMarkets: data.phoenixMarkets,
    hip3Markets: { ...data.hip3Markets },
    timestamp: data.timestamp,
  }
}

async function fetchMarketsWithFallback(
  providerName: string,
  fetchMarkets: () => Promise<any[]>,
  previousMarkets: any[],
): Promise<any[]> {
  try {
    const markets = await fetchMarkets()
    if (markets.length === 0 && previousMarkets.length > 0) {
      log.warn(
        `[arb-registry] ${providerName} returned 0 markets; keeping ${previousMarkets.length} cached markets instead`,
      )
      return previousMarkets
    }
    return markets
  } catch (error) {
    if (previousMarkets.length > 0) {
      log.warn(
        `[arb-registry] ${providerName} market refresh failed; keeping ${previousMarkets.length} cached markets instead:`,
        error,
      )
      return previousMarkets
    }
    log.error(`[arb-registry] ${providerName} market refresh failed with no cached fallback:`, error)
    return []
  }
}

async function resolveHip3IndexMap(ethAddress: string): Promise<Map<Hip3DexName, number>> {
  const now = Date.now()
  if (hip3IndexCache && now - hip3IndexCache.timestamp < HIP3_INDEX_TTL_MS) {
    return hip3IndexCache.map
  }
  if (hip3IndexFetchPromise) return hip3IndexFetchPromise
  hip3IndexFetchPromise = (async () => {
    try {
      const hlClient = createHyperliquidClient(ethAddress)
      const perpDexs = await hlClient.getPerpDexs()
      const map = new Map<Hip3DexName, number>()
      for (let i = 0; i < perpDexs.length; i++) {
        const entry = perpDexs[i]
        if (!entry) continue
        if (isSupportedHip3Dex(entry.name)) map.set(entry.name, i)
      }
      hip3IndexCache = { map, timestamp: Date.now() }
      return map
    } finally {
      hip3IndexFetchPromise = null
    }
  })()
  return hip3IndexFetchPromise
}

/**
 * Get the global cached registry for market data
 * Initializes once at first call, then reuses
 */
export async function getMarketDataRegistry(): Promise<ArbProviderRegistry> {
  if (globalMarketDataRegistry?.isReady()) {
    return globalMarketDataRegistry
  }

  // If already initializing, wait for it
  if (globalRegistryInitPromise) {
    return globalRegistryInitPromise
  }

  // Start initialization
  globalRegistryInitPromise = (async () => {
    log.info('[arb-registry] Initializing global market data registry...')
    const registry = new ArbProviderRegistry(DUMMY_KEYPAIR.publicKey)
    await registry.initialize()
    globalMarketDataRegistry = registry
    log.info('[arb-registry] Global market data registry ready')
    return registry
  })()

  return globalRegistryInitPromise
}

/**
 * Get cached market data (refreshes every 30 seconds)
 */
export async function getCachedMarketData(): Promise<{
  pacificaMarkets: any[]
  hyperliquidMarkets: any[]
  asterMarkets: any[]
  lighterMarkets: any[]
  zoMarkets: any[]
  phoenixMarkets: any[]
  hip3Markets: Record<string, any[]>
}> {
  const now = Date.now()

  // Return cached data if still valid
  if (cachedMarketData && (now - cachedMarketData.timestamp) < MARKET_CACHE_TTL_MS) {
    return cloneCachedMarketData(cachedMarketData)
  }

  if (marketDataRefreshPromise) {
    return cloneCachedMarketData(await marketDataRefreshPromise)
  }

  marketDataRefreshPromise = (async () => {
    const previous = cachedMarketData

    const registry = await getMarketDataRegistry()
    const pacificaProvider = registry.getProvider('pacifica')
    const hyperliquidProvider = registry.getProvider('hyperliquid')
    const asterProvider = registry.getProvider('aster')
    const lighterProvider = registry.getProvider('lighter')
    const zoProvider = registry.getProvider('01')
    const phoenixProvider = registry.getProvider('phoenix')
    const hip3Providers = registry.getHip3Providers()

    const hip3Entries = Array.from(hip3Providers.entries())
    const [pacificaMarkets, hyperliquidMarkets, asterMarkets, lighterMarkets, zoMarkets, phoenixMarkets, ...hip3Results] = await Promise.all([
      fetchMarketsWithFallback(
        'Pacifica',
        () => pacificaProvider?.getAllMarkets() ?? Promise.resolve([] as any[]),
        previous?.pacificaMarkets ?? [],
      ),
      fetchMarketsWithFallback(
        'Hyperliquid',
        () => hyperliquidProvider?.getAllMarkets() ?? Promise.resolve([] as any[]),
        previous?.hyperliquidMarkets ?? [],
      ),
      fetchMarketsWithFallback(
        'Aster',
        () => asterProvider?.getAllMarkets() ?? Promise.resolve([] as any[]),
        previous?.asterMarkets ?? [],
      ),
      fetchMarketsWithFallback(
        'Lighter',
        () => lighterProvider?.getAllMarkets() ?? Promise.resolve([] as any[]),
        previous?.lighterMarkets ?? [],
      ),
      fetchMarketsWithFallback(
        '01',
        () => zoProvider?.getAllMarkets() ?? Promise.resolve([] as any[]),
        previous?.zoMarkets ?? [],
      ),
      fetchMarketsWithFallback(
        'Phoenix',
        () => phoenixProvider?.getAllMarkets() ?? Promise.resolve([] as any[]),
        previous?.phoenixMarkets ?? [],
      ),
      ...hip3Entries.map(([dexName, provider]) =>
        fetchMarketsWithFallback(
          `HIP-3 ${dexName}`,
          () => provider.getAllMarkets(),
          previous?.hip3Markets[dexName] ?? [],
        ),
      ),
    ])

    const hip3Markets: Record<string, any[]> = {}
    hip3Entries.forEach(([dexName], i) => {
      hip3Markets[dexName] = hip3Results[i] ?? []
    })

    cachedMarketData = {
      pacificaMarkets,
      hyperliquidMarkets,
      asterMarkets,
      lighterMarkets,
      zoMarkets,
      phoenixMarkets,
      hip3Markets,
      timestamp: Date.now(),
    }

    const hip3Summary = hip3Entries.map(([name], i) => `${name}:${hip3Results[i]?.length ?? 0}`).join(', ')
    log.info(
      `[arb-registry] Market data cached: ${pacificaMarkets.length} Pacifica, ${hyperliquidMarkets.length} Hyperliquid, ${asterMarkets.length} Aster, ${lighterMarkets.length} Lighter, ${zoMarkets.length} 01, ${phoenixMarkets.length} Phoenix, HIP-3: {${hip3Summary}}`,
    )

    return cachedMarketData
  })()

  try {
    return cloneCachedMarketData(await marketDataRefreshPromise)
  } finally {
    marketDataRefreshPromise = null
  }
}

/**
 * Initialize global registry at startup (call from main.ts)
 */
export async function initializeArbRegistry(): Promise<void> {
  await getMarketDataRegistry()
  // Pre-warm the market cache
  await getCachedMarketData()
}

/**
 * Provider registry for arbitrage trading
 * Creates and manages provider instances for a given wallet
 */
export class ArbProviderRegistry {
  private providers: Map<string, IArbProvider> = new Map()
  private hip3Providers: Map<Hip3DexName, Hip3HyperliquidArbProvider> = new Map()
  private walletPubkey: PublicKey
  private initialized = false

  constructor(walletPubkey: PublicKey) {
    this.walletPubkey = walletPubkey
  }

  /**
   * Initialize providers.
   * @param ethAddress - Ethereum address for Hyperliquid/Aster/Lighter
   * @param protocols - Optional filter: only initialize these providers. If omitted, initializes all.
   */
  async initialize(ethAddress?: string, protocols?: string[]): Promise<void> {
    if (this.initialized) return

    const all = ['pacifica', 'hyperliquid', 'aster', 'lighter', '01', 'phoenix']
    const requested = protocols ?? all

    // Separate HIP-3 requests (`hl:<name>`) from the base protocols.
    const hip3Requested: Hip3DexName[] = []
    const baseRequested: string[] = []
    for (const name of requested) {
      if (name.startsWith('hl:')) {
        const dex = name.slice(3)
        if (isSupportedHip3Dex(dex)) hip3Requested.push(dex)
      } else {
        baseRequested.push(name)
      }
    }
    // If no explicit protocol list was given, include all curated HIP-3 dexes too.
    const hip3ToInit = protocols ? hip3Requested : [...HIP3_DEX_NAMES]

    // Discover HIP-3 dex indexes (1-based positions in the perpDexs array).
    // Module-level cache avoids hitting HL for every registry init.
    const hip3IndexMap = new Map<Hip3DexName, number>()
    if (hip3ToInit.length > 0) {
      try {
        const globalMap = await resolveHip3IndexMap(ethAddress || DUMMY_ETH_ADDRESS)
        for (const name of hip3ToInit) {
          const idx = globalMap.get(name)
          if (idx !== undefined) hip3IndexMap.set(name, idx)
        }
        const missing = hip3ToInit.filter(n => !hip3IndexMap.has(n))
        if (missing.length > 0) {
          log.warn(`[arb-registry] HIP-3 dexes requested but not found on-chain: ${missing.join(', ')}`)
        }
      } catch (error) {
        log.error('[arb-registry] Failed to fetch perpDexs — HIP-3 providers will be skipped:', error)
      }
    }

    // Create only requested providers
    const providerEntries: Array<{ name: string; provider: IArbProvider }> = []
    for (const name of baseRequested) {
      switch (name) {
        case 'pacifica':
          providerEntries.push({ name, provider: createPacificaArbProvider(this.walletPubkey) })
          break
        case 'hyperliquid':
          providerEntries.push({ name, provider: createHyperliquidArbProvider(ethAddress || DUMMY_ETH_ADDRESS) })
          break
        case 'aster':
          providerEntries.push({ name, provider: createAsterArbProvider() })
          break
        case 'lighter':
          providerEntries.push({ name, provider: createLighterArbProvider() })
          break
        case '01':
          providerEntries.push({ name, provider: createZoArbProvider({ walletPubkey: this.walletPubkey }) })
          break
        case 'phoenix':
          providerEntries.push({ name, provider: createPhoenixArbProvider({ walletPubkey: this.walletPubkey }) })
          break
      }
    }

    // Instantiate one Hip3HyperliquidArbProvider per discovered curated dex.
    const hip3Entries: Array<{ dexName: Hip3DexName; provider: Hip3HyperliquidArbProvider }> = []
    for (const [dexName, perpDexIndex] of hip3IndexMap.entries()) {
      const provider = createHip3HyperliquidArbProvider({
        dexName,
        perpDexIndex,
        collateral: getHip3Collateral(dexName),
        ethAddress: ethAddress || DUMMY_ETH_ADDRESS,
      })
      providerEntries.push({ name: getHip3ProtocolId(dexName), provider })
      hip3Entries.push({ dexName, provider })
    }

    // Initialize in parallel with timeouts
    const timeoutMs = 30000
    const withTimeout = <T>(promise: Promise<T>, name: string): Promise<T> => {
      return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`${name} initialization timed out after ${timeoutMs}ms`)), timeoutMs)
        )
      ])
    }

    log.info(`[arb-registry] Starting provider initialization (${providerEntries.map(e => e.name).join(', ')})...`)
    const results = await Promise.allSettled(
      providerEntries.map(e => withTimeout(e.provider.initialize(), e.name))
    )
    log.info('[arb-registry] Provider initialization complete')

    for (let i = 0; i < providerEntries.length; i++) {
      const { name, provider } = providerEntries[i]
      if (results[i].status === 'fulfilled') {
        this.providers.set(name, provider)
        log.info(`[arb-registry] ${name} provider initialized`)
      } else {
        log.error(`[arb-registry] Failed to initialize ${name} provider:`, (results[i] as PromiseRejectedResult).reason)
      }
    }

    // Track HIP-3 providers separately for typed access (only those that
    // initialized successfully).
    for (const { dexName, provider } of hip3Entries) {
      if (this.providers.has(getHip3ProtocolId(dexName))) {
        this.hip3Providers.set(dexName, provider)
      }
    }

    if (this.providers.size === 0) {
      throw new Error('No arbitrage providers could be initialized')
    }

    this.initialized = true
    log.info(`[arb-registry] Initialized with ${this.providers.size} providers`)
  }

  /**
   * Get a specific provider by name. Accepts base protocols
   * (`pacifica`, `hyperliquid`, `aster`, `lighter`, `01`) plus HIP-3
   * protocol ids (`hl:<dexName>`).
   */
  getProvider(name: string): IArbProvider | null {
    return this.providers.get(name) || null
  }

  /** Get a specific HIP-3 provider by dex name (typed). */
  getHip3Provider(dexName: Hip3DexName): Hip3HyperliquidArbProvider | null {
    return this.hip3Providers.get(dexName) ?? null
  }

  /** All initialized HIP-3 providers, keyed by dex name. */
  getHip3Providers(): Map<Hip3DexName, Hip3HyperliquidArbProvider> {
    return this.hip3Providers
  }

  /**
   * Get the Hyperliquid provider (typed for specific methods)
   */
  getHyperliquidProvider(): HyperliquidArbProvider | null {
    return this.providers.get('hyperliquid') as HyperliquidArbProvider | null
  }

  /**
   * Get the Pacifica provider (typed for specific methods like getLotSize)
   */
  getPacificaProvider(): PacificaArbProvider | null {
    return this.providers.get('pacifica') as PacificaArbProvider | null
  }

  /**
   * Get the Aster provider (typed for specific methods)
   */
  getAsterProvider(): AsterArbProvider | null {
    return this.providers.get('aster') as AsterArbProvider | null
  }

  /**
   * Get the Lighter provider (typed for specific methods)
   */
  getLighterProvider(): LighterArbProvider | null {
    return this.providers.get('lighter') as LighterArbProvider | null
  }

  /**
   * Get the 01 (zo) provider (typed for specific methods)
   */
  getZoProvider(): ZoArbProvider | null {
    return this.providers.get('01') as ZoArbProvider | null
  }

  /**
   * Get the Phoenix provider (typed for specific methods)
   */
  getPhoenixProvider(): PhoenixArbProvider | null {
    return this.providers.get('phoenix') as PhoenixArbProvider | null
  }

  /**
   * Get all initialized providers
   */
  getAllProviders(): Map<string, IArbProvider> {
    return this.providers
  }

  /**
   * Check if a provider is available
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name)
  }

  /**
   * Check if registry is initialized and ready
   */
  isReady(): boolean {
    return this.initialized && this.providers.size > 0
  }

  /**
   * Cleanup all providers
   */
  async cleanup(): Promise<void> {
    for (const [name, provider] of this.providers) {
      try {
        await provider.cleanup()
        log.info(`[arb-registry] Cleaned up ${name} provider`)
      } catch (error) {
        log.error(`[arb-registry] Error cleaning up ${name} provider:`, error)
      }
    }
    this.providers.clear()
    this.hip3Providers.clear()
    this.initialized = false
  }
}

/**
 * Factory function to create and initialize the provider registry
 * @param walletPubkey - Solana wallet public key
 * @param ethAddress - Optional Ethereum address for Hyperliquid/Aster/Lighter
 * @param protocols - Optional filter: only initialize these providers
 */
export async function getInitializedProviders(
  walletPubkey: PublicKey,
  ethAddress?: string,
  protocols?: string[]
): Promise<ArbProviderRegistry> {
  const registry = new ArbProviderRegistry(walletPubkey)
  await registry.initialize(ethAddress, protocols)
  return registry
}
