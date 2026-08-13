import {
  PhoenixHttpClient,
  createPhoenixClient,
  type PhoenixClient,
  type PhoenixClientConfig,
} from '@ellipsis-labs/rise'

const DEFAULT_API_URL = 'https://perp-api.phoenix.trade'

function resolveApiUrl(): string {
  return process.env.PHOENIX_API_URL || DEFAULT_API_URL
}

function resolveRpcUrl(): string | undefined {
  return process.env.SOLANA_MAINNET_RPC_URL || process.env.SOLANA_RPC_URL
}

let httpSingleton: PhoenixHttpClient | null = null

/**
 * HTTP-only client for read paths (exchange snapshot, markets, funding,
 * trader-state, invite activation). No Solana RPC required.
 */
export function getPhoenixHttpClient(): PhoenixHttpClient {
  if (!httpSingleton) {
    httpSingleton = new PhoenixHttpClient({ apiUrl: resolveApiUrl() })
  }
  return httpSingleton
}

/**
 * Create a unified Phoenix client (HTTP + RPC + instruction builders + streams).
 * Used by trade / deposit / withdraw / TP-SL paths that need to build Solana ixs.
 */
export function createPhoenixSdkClient(overrides: Partial<PhoenixClientConfig> = {}): PhoenixClient {
  return createPhoenixClient({
    apiUrl: resolveApiUrl(),
    rpcUrl: resolveRpcUrl(),
    ws: false,
    exchangeMetadata: { stream: false },
    ...overrides,
  })
}

export { MarginType, Side, type PhoenixClient } from '@ellipsis-labs/rise'
