// Logger
export { log, setLogger } from './logger'
export type { Logger } from './logger'

// Constants
export { SOLANA_RPC_URL, SOLANA_NETWORK, DUMMY_KEYPAIR, DUMMY_ETH_ADDRESS } from './constants'

// Types
export * from './types'

// Registry
export {
  ArbProviderRegistry,
  getInitializedProviders,
  getMarketDataRegistry,
  getCachedMarketData,
  initializeArbRegistry,
} from './registry'

// Providers
export {
  PacificaArbProvider,
  createPacificaArbProvider,
  normalizePacificaSymbol,
  createPacificaPayload,
  executePacificaMarketOrder,
  setPacificaLeverage,
  setPacificaMarginMode,
  createReferralClaimPayload,
  claimPacificaReferralCode,
} from './providers/pacifica-provider'
export { HyperliquidArbProvider, createHyperliquidArbProvider, normalizeHyperliquidSymbol } from './providers/hyperliquid-provider'
export { Hip3HyperliquidArbProvider, createHip3HyperliquidArbProvider } from './providers/hip3-hyperliquid-provider'
export {
  HIP3_DEXES,
  HIP3_DEX_NAMES,
  isSupportedHip3Dex,
  getHip3Collateral,
  getHip3ProtocolId,
  parseHip3ProtocolId,
  isHip3ProtocolId,
} from './hip3/dex-config'
export type { Hip3DexName, Hip3Collateral, Hip3ProtocolId } from './hip3/dex-config'
export { AsterArbProvider, createAsterArbProvider, normalizeAsterSymbol } from './providers/aster-provider'
export { LighterArbProvider, createLighterArbProvider, normalizeLighterSymbol } from './providers/lighter-provider'
export { ZoArbProvider, createZoArbProvider, normalizeZoSymbol } from './providers/zo-provider'
export type { ZoSessionCreds } from './providers/zo-provider'
export {
  loadZoSchema,
  encodeAction,
  decodeReceipt,
  packEnvelope,
  hexEncode,
  sessionSign,
  generateZoSessionKeypair,
  keypairFromSecret,
  toScaledU64,
} from './clients/zo-codec'
export type { ZoKeypair, ZoProtoTypes } from './clients/zo-codec'

// Clients
export {
  AsterClient,
  createAsterClient,
} from './clients/aster-client'
export type {
  AsterSymbolInfo,
  AsterPremiumIndex,
  AsterAccountInfo,
  AsterPositionRisk,
  AsterOrderResponse,
  AsterWithdrawFeeEstimate,
  AsterWithdrawResponse,
  AsterBalanceEntry,
  AsterIncomeEntry,
  AsterFundingRate,
} from './clients/aster-client'

export {
  HyperliquidClient,
  createHyperliquidClient,
  formatHyperliquidPrice,
  formatHyperliquidSize,
} from './clients/hyperliquid-client'
export type {
  HyperliquidMeta,
  HyperliquidAssetMeta,
  HyperliquidClearinghouseState,
  HyperliquidAssetPosition,
  HyperliquidOrderParams,
  HyperliquidOrderResponse,
  HyperliquidFundingHistory,
  HyperliquidAssetCtx,
  HyperliquidUserFees,
  HyperliquidUserFundingEntry,
  HyperliquidSpotMeta,
  HyperliquidSpotClearinghouseState,
  EIP712TypedData,
  HyperliquidSignature,
  SignTypedDataFn,
} from './clients/hyperliquid-client'

export {
  ZoClient,
  createZoClient,
  ZO_MAINNET_BASE,
  ZO_DEVNET_BASE,
} from './clients/zo-client'
export type {
  ZoMarketSpec,
  ZoTokenSpec,
  ZoInfoResponse,
  ZoPerpStats,
  ZoMarketStats,
  ZoClientOptions,
} from './clients/zo-client'

export {
  LighterClient,
  createLighterClient,
} from './clients/lighter-client'
export type {
  LighterOrderBookDetail,
  LighterAccountInfo,
  LighterPosition,
  LighterFundingRate as LighterFundingRateEntry,
  LighterOrderResponse,
  LighterMarketData,
} from './clients/lighter-client'

// Lighter signer
export {
  generateAPIKey,
  createClient as createLighterSignerClient,
  checkClient,
  signChangePubKey,
  signCreateOrder,
  signCancelOrder,
  signUpdateLeverage,
  signTransfer,
  signWithdraw,
  createAuthToken,
} from './lighter/signer'
export type {
  LighterApiKey,
  LighterSignedTx,
  LighterCredentials,
} from './lighter/signer'

// Market data
export { fetchCurrentPrice } from './market-data'

// Funding rates
export type { DexName, FundingRateRecord } from './funding-rates/types'
export { canonicalizeSymbol, pLimit, withRetry, floorToHour, nextHourMs, nextHalfHourMs, advanceToFuture, hoursAgo, daysAgo, sleep } from './funding-rates/utils'
