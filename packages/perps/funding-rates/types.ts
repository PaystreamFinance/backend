import type { Hip3ProtocolId } from '../hip3/dex-config'

export type DexName = 'hyperliquid' | 'pacifica' | 'aster' | 'lighter' | '01' | 'phoenix' | Hip3ProtocolId

export interface FundingRateRecord {
  dex: DexName
  symbol: string           // Canonical: 'BTC', '1000PEPE', etc.
  protocolSymbol: string   // Native DEX symbol: 'BTC-PERP', 'kPEPE', 'BTCUSDT'
  timestamp: Date          // Settlement time (hour-aligned)
  rate: number             // Funding rate as decimal (0.0001 = 0.01%)
  granularity: '1h' | '8h'
}
