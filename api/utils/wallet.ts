import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import {
  getMint,
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token'
import { LAMPORTS_PER_SOL } from './constants'
import BN from 'bn.js'

/**
 * Extract embedded Solana wallet from Privy user linked_accounts
 * Returns both address and wallet ID
 */
export function extractEmbeddedSolanaWallet(linkedAccounts: any[]): {
  address: string
  walletId: string
} | null {
  const embedded = (linkedAccounts.find(
    (a: any) => a.wallet_client_type === 'privy' && a.chain_type === 'solana',
  ) ?? {}) as any

  // The wallet ID is in the 'id' field, not 'wallet_id'
  if (!embedded.address || !embedded.id) {
    return null
  }

  return {
    address: embedded.address,
    walletId: embedded.id,
  }
}

/**
 * Extract embedded Ethereum wallet from Privy user linked_accounts
 * Returns both address (0x format) and wallet ID
 * Used for Hyperliquid which requires EIP-712 signing
 */
export function extractEmbeddedEthWallet(linkedAccounts: any[]): {
  address: string
  walletId: string
} | null {
  const embedded = (linkedAccounts.find(
    (a: any) => a.wallet_client_type === 'privy' && a.chain_type === 'ethereum',
  ) ?? {}) as any

  // The wallet ID is in the 'id' field
  if (!embedded.address || !embedded.id) {
    return null
  }

  return {
    address: embedded.address.toLowerCase(),
    walletId: embedded.id,
  }
}

/**
 * Convert SOL amount to lamports
 */
export function solToLamports(sol: number): number {
  return Math.floor(sol * LAMPORTS_PER_SOL)
}

/**
 * Convert lamports to SOL
 */
export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL
}

/**
 * Fetch token decimals from chain
 * Falls back to default decimals if mint account doesn't exist or fetch fails
 */
export async function fetchTokenDecimals(
  connection: Connection,
  mint: PublicKey,
  fallbackDecimals: number = 9,
): Promise<number> {
  try {
    // First check account info to detect token program
    const accountInfo = await connection.getAccountInfo(mint)
    
    if (!accountInfo) {
      console.warn(
        `Mint account ${mint.toString()} does not exist, using fallback: ${fallbackDecimals}`,
      )
      return fallbackDecimals
    }

    // Detect token program by checking account owner
    const tokenProgram = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID

    // Verify account is owned by a token program
    if (
      !accountInfo.owner.equals(TOKEN_PROGRAM_ID) &&
      !accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ) {
      console.warn(
        `Mint account ${mint.toString()} is not owned by Token Program or Token-2022 Program. Owner: ${accountInfo.owner.toString()}, using fallback: ${fallbackDecimals}`,
      )
      return fallbackDecimals
    }

    // Try to get mint info with detected token program
    const mintInfo = await getMint(connection, mint, undefined, tokenProgram)
    return mintInfo.decimals
  } catch (error: any) {
    const errorName = error?.constructor?.name || ''
    const errorMessage = error?.message || ''
    
    // Check account info to understand why it failed
    let accountInfo = null
    try {
      accountInfo = await connection.getAccountInfo(mint)
    } catch {
      // Ignore errors when checking account info
    }
    
    // Log detailed error information
    console.warn(
      `Failed to fetch decimals for ${mint.toString()}, using fallback: ${fallbackDecimals}`,
      {
        errorName,
        errorMessage,
        accountExists: accountInfo !== null,
        accountOwner: accountInfo?.owner?.toString() || 'N/A',
        accountExecutable: accountInfo?.executable || false,
        accountLamports: accountInfo?.lamports || 0,
      },
    )
    
    return fallbackDecimals
  }
}

/**
 * Convert base units (BigInt) to human-readable string
 */
export function baseUnitsToHumanReadable(
  amountBase: bigint,
  decimals: number,
): string {
  const decimalsBN = BigInt(10 ** decimals)
  const integerPart = amountBase / decimalsBN
  const decimalPart = amountBase % decimalsBN
  const decimalStr = decimalPart.toString().padStart(decimals, '0')
  const trimmedDecimal = decimalStr.replace(/0+$/, '')
  return trimmedDecimal
    ? `${integerPart.toString()}.${trimmedDecimal}`
    : integerPart.toString()
}

/**
 * Convert human-readable string to base units (BigInt)
 */
export function humanReadableToBaseUnits(
  amount: string,
  decimals: number,
): bigint {
  const [intPart, decPart = ''] = amount.split('.')
  const paddedDec = decPart.padEnd(decimals, '0').slice(0, decimals)
  return (
    BigInt(intPart || '0') * BigInt(10 ** decimals) + BigInt(paddedDec || '0')
  )
}

/**
 * Safely convert human-readable token amount to BN (base units)
 * Handles floating point precision issues by using string parsing when possible
 *
 * @param amount - Amount as number or string (e.g., 0.1 or "0.1")
 * @param decimals - Number of decimals (e.g., 9 for SOL)
 * @returns BN representing the amount in smallest units
 */
export function amountToBN(amount: number | string, decimals: number): BN {
  let result: BN

  // If amount is a string, parse it precisely
  if (typeof amount === 'string') {
    const [intPart = '0', decPart = ''] = amount.split('.')
    const paddedDec = decPart.padEnd(decimals, '0').slice(0, decimals)
    result = new BN(intPart)
      .mul(new BN(10).pow(new BN(decimals)))
      .add(new BN(paddedDec || '0'))
  } else {
    // For numbers, use Math.floor to handle floating point precision issues
    // Note: Very large numbers (> 10^15) or extreme decimals may lose precision
    // For exact precision with large amounts, use string input instead
    const calculated = Math.floor(amount * 10 ** decimals)
    result = new BN(calculated)
  }

  return result
}

/**
 * Get Associated Token Account address for a mint and owner
 */
export async function getATAAddress(
  mint: PublicKey | string,
  owner: PublicKey | string,
): Promise<PublicKey> {
  const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint
  const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner
  return await getAssociatedTokenAddress(mintPubkey, ownerPubkey)
}

/**
 * Create idempotent ATA instruction
 */
export async function createATAInstruction(
  payer: PublicKey | string,
  mint: PublicKey | string,
  owner: PublicKey | string,
) {
  const payerPubkey = typeof payer === 'string' ? new PublicKey(payer) : payer
  const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint
  const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner

  const ata = await getATAAddress(mintPubkey, ownerPubkey)
  return createAssociatedTokenAccountIdempotentInstruction(
    payerPubkey,
    ata,
    ownerPubkey,
    mintPubkey,
  )
}

/**
 * Check if user has positive balance for a token account
 * Returns balance in human-readable format or null if account doesn't exist
 */
export async function getTokenBalance(
  connection: Connection,
  mint: PublicKey | string,
  owner: PublicKey | string,
  decimals: number,
): Promise<number | null> {
  try {
    const ata = await getATAAddress(mint, owner)
    const tokenAccount = await getAccount(connection, ata)
    return Number(tokenAccount.amount) / Math.pow(10, decimals)
  } catch (error) {
    if (error instanceof TokenAccountNotFoundError || error instanceof TokenInvalidAccountOwnerError) {
      return null
    }
    throw error
  }
}

// /**
//  * Load wallet keypair from mainnet-wallet.json
//  * Returns the keypair for SDK initialization
//  */
// export function loadMainnetWallet(): Keypair {
//   try {
//     const fs = require('fs')
//     const path = require('path')
//     const walletPath = path.join(process.cwd(), 'mainnet-wallet.json')
//     const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf-8'))

//     if (!walletData.secretKey || !Array.isArray(walletData.secretKey)) {
//       throw new Error('Invalid wallet format: secretKey must be an array')
//     }

//     const secretKey = new Uint8Array(walletData.secretKey)
//     return Keypair.fromSecretKey(secretKey)
//   } catch (error) {
//     console.warn('Failed to load mainnet wallet, using dummy keypair:', error)
//     // Fallback to dummy keypair if wallet file doesn't exist or is invalid
//     return Keypair.generate()
//   }
// }
