import { createZoClient, getZoInfoDerived, type ZoClient, type ZoTokenSpec } from '@paystream/perps/clients/zo-client'

interface CachedInfo {
  tokenById: Map<number, ZoTokenSpec>
  tokenSymbolById: Map<number, string>
}

/**
 * Token-id lookup maps derived from 01's /info. Memoized per cached /info
 * response so warm callers pay zero (build-once, reuse until the upstream
 * cache refreshes).
 */
export async function getZoInfoCache(client: ZoClient = createZoClient()): Promise<CachedInfo> {
  return getZoInfoDerived(client, 'zo-info-cache:tokens', info => ({
    tokenById: new Map(info.tokens.map(t => [t.tokenId, t])),
    tokenSymbolById: new Map(info.tokens.map(t => [t.tokenId, t.symbol])),
  }))
}
