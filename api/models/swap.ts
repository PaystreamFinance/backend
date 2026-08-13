export interface SwapRecord {
  publicId: string
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  txHash: string
  createdAt: string
}

export interface SwapActivitySuccessResponse {
  status: 'success'
  swaps: SwapRecord[]
  pagination: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
}

export interface SwapActivityErrorResponse {
  status: 'error'
  message: string
  error?: string
}
