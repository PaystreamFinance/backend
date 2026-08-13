export interface SpotPerpCheckJobData {
  tradeId: number
  market: string
  spotTokenMint: string
  perpProtocol: string
  perpTxnHash: string | null
  perpLiquidationPrice: number | null
  perpMarginUsd: number
  perpNotionalUsd: number
  perpLeverage: number
  sizeAsset: number | null
  privyUserId: string
  userPubkey: string
  ethAddress: string | null
  createdAt: string
  /** 'open' for normal checks, 'closing' for retry verification */
  status: 'open' | 'closing'
}
