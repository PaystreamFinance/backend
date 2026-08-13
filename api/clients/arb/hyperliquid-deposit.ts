import { log } from '../../utils/log'

// Unit API endpoints
const UNIT_MAINNET = 'https://api.hyperunit.xyz'
const UNIT_TESTNET = 'https://api.hyperunit-testnet.xyz'

/**
 * Supported assets for Solana deposits via Unit protocol
 */
export type HyperliquidDepositAsset = 'sol' | 'bonk' | 'fartcoin' | 'pump' | 'spx' | '2z'

/**
 * Guardian signatures for deposit address verification
 */
export interface GuardianSignatures {
  'field-node': string
  'hl-node': string
  'node-1': string
}

/**
 * Deposit address response from Unit API
 */
export interface HyperliquidDepositAddressResponse {
  address: string
  signatures: GuardianSignatures
  status: 'OK' | string
}

/**
 * Minimum deposit amounts for each asset
 */
export const HYPERLIQUID_MIN_DEPOSITS: Record<HyperliquidDepositAsset, number> = {
  sol: 0.12,
  bonk: 1000000,
  fartcoin: 100,
  pump: 10,
  spx: 1,
  '2z': 1,
}

/**
 * Asset names to Unit API format mapping
 */
const ASSET_MAP: Record<HyperliquidDepositAsset, string> = {
  sol: 'sol',
  bonk: 'bonk',
  fartcoin: 'fartcoin',
  pump: 'pump',
  spx: 'spx',
  '2z': '2z',
}

/**
 * Get a Solana deposit address for Hyperliquid via Unit protocol
 *
 * @param ethAddress - The user's Hyperliquid (Ethereum) address
 * @param asset - The asset to deposit (default: 'sol')
 * @param testnet - Whether to use testnet API
 * @returns Deposit address and guardian signatures
 */
export async function getHyperliquidDepositAddress(
  ethAddress: string,
  asset: HyperliquidDepositAsset = 'sol',
  testnet: boolean = false
): Promise<HyperliquidDepositAddressResponse> {
  const baseUrl = testnet ? UNIT_TESTNET : UNIT_MAINNET
  const assetPath = ASSET_MAP[asset]

  if (!assetPath) {
    throw new Error(`Unsupported asset: ${asset}. Supported: ${Object.keys(ASSET_MAP).join(', ')}`)
  }

  // Normalize Ethereum address
  const normalizedAddress = ethAddress.toLowerCase()
  if (!normalizedAddress.startsWith('0x') || normalizedAddress.length !== 42) {
    throw new Error('Invalid Ethereum address format')
  }

  const url = `${baseUrl}/gen/solana/hyperliquid/${assetPath}/${normalizedAddress}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error(`[hl-deposit] Unit API error: ${response.status} - ${errorText}`)
      throw new Error(`Unit API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json() as HyperliquidDepositAddressResponse

    if (data.status !== 'OK') {
      throw new Error(`Unit API returned status: ${data.status}`)
    }

    return data
  } catch (error) {
    log.error('[hl-deposit] Error generating deposit address:', error)
    throw error
  }
}

/**
 * Get a Hyperliquid withdraw address for bridging to Solana via Unit protocol
 * This is the reverse of deposit: gen/hyperliquid/solana instead of gen/solana/hyperliquid
 *
 * @param solanaAddress - The user's Solana wallet address (destination for SOL)
 * @param asset - The asset to withdraw (default: 'sol')
 * @param testnet - Whether to use testnet API
 * @returns Withdraw address on Hyperliquid (0x) where you spotSend tokens, and guardian signatures
 */
export async function getHyperliquidWithdrawAddress(
  solanaAddress: string,
  asset: HyperliquidDepositAsset = 'sol',
  testnet: boolean = false
): Promise<HyperliquidDepositAddressResponse> {
  const baseUrl = testnet ? UNIT_TESTNET : UNIT_MAINNET
  const assetPath = ASSET_MAP[asset]

  if (!assetPath) {
    throw new Error(`Unsupported asset: ${asset}. Supported: ${Object.keys(ASSET_MAP).join(', ')}`)
  }

  // Reversed: hyperliquid/solana (withdraw from HL to Solana)
  const url = `${baseUrl}/gen/hyperliquid/solana/${assetPath}/${solanaAddress}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error(`[hl-withdraw] Unit API error: ${response.status} - ${errorText}`)
      throw new Error(`Unit withdraw address error: ${response.status} - ${errorText}`)
    }

    const data = await response.json() as HyperliquidDepositAddressResponse

    if (data.status !== 'OK') {
      throw new Error(`Unit API returned status: ${data.status}`)
    }

    log.info(`[hl-withdraw] Got Unit withdraw address: ${data.address} for Solana dest ${solanaAddress}`)
    return data
  } catch (error) {
    log.error('[hl-withdraw] Error generating withdraw address:', error)
    throw error
  }
}

/**
 * Deposit status information
 */
export interface DepositStatus {
  found: boolean
  confirmed: boolean
  creditedToHyperliquid: boolean
  amount?: number
  asset?: string
  timestamp?: number
}

/**
 * Check the status of a Solana deposit
 * Note: This is a placeholder - actual implementation would need to:
 * 1. Query the Solana blockchain for the transaction
 * 2. Check Hyperliquid balance changes
 *
 * @param txHash - The Solana transaction hash
 * @param ethAddress - The user's Hyperliquid address
 */
export async function checkDepositStatus(
  txHash: string,
  ethAddress: string
): Promise<DepositStatus> {
  // For now, return a basic status
  // In production, this would query both Solana and Hyperliquid APIs

  // TODO: Implement actual deposit tracking
  // 1. Query Solana RPC for transaction confirmation
  // 2. Query Hyperliquid for balance changes
  // 3. Match deposits by amount and timing

  return {
    found: false,
    confirmed: false,
    creditedToHyperliquid: false,
  }
}

/**
 * Validate deposit amount against minimum requirements
 */
export function validateDepositAmount(asset: HyperliquidDepositAsset, amount: number): {
  valid: boolean
  minAmount: number
  message?: string
} {
  const minAmount = HYPERLIQUID_MIN_DEPOSITS[asset]

  if (amount < minAmount) {
    return {
      valid: false,
      minAmount,
      message: `Minimum deposit for ${asset.toUpperCase()} is ${minAmount}`,
    }
  }

  return {
    valid: true,
    minAmount,
  }
}

/**
 * Get all supported deposit assets and their minimum amounts
 */
export function getSupportedDepositAssets(): Array<{
  asset: HyperliquidDepositAsset
  minAmount: number
}> {
  return Object.entries(HYPERLIQUID_MIN_DEPOSITS).map(([asset, minAmount]) => ({
    asset: asset as HyperliquidDepositAsset,
    minAmount,
  }))
}
