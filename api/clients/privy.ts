import { PrivyClient } from '@privy-io/node'
import { createViemAccount as privyCreateViemAccount } from '@privy-io/node/viem'
import * as bs58 from 'bs58'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'
import type { LocalAccount, Hex } from 'viem'
import type { EIP712TypedData, HyperliquidSignature } from '@paystream/perps/clients/hyperliquid-client'

const appId = Bun.env.PRIVY_APP_ID as string
const appSecret = Bun.env.PRIVY_APP_SECRET as string
const privyAuthKey = Bun.env.PRIVY_AUTH_PKEY as string

if (!appId || !appSecret) {
  throw new Error('Missing PRIVY_APP_ID or PRIVY_APP_SECRET')
}

/**
 * Derive Ethereum address from a raw hex private key
 */
function privateKeyToAddress(privateKeyHex: string): string {
  // Remove 0x prefix if present
  const keyHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
  const keyBytes = Buffer.from(keyHex, 'hex')

  // Get public key (uncompressed, 65 bytes starting with 0x04)
  const publicKey = secp256k1.getPublicKey(keyBytes, false)

  // Take keccak256 of public key (excluding the 0x04 prefix)
  const hash = keccak_256(publicKey.slice(1))

  // Take last 20 bytes as address
  const address = '0x' + bytesToHex(hash.slice(-20))
  return address.toLowerCase()
}

/**
 * Parse Privy PKCS#8 format private key and derive address
 * Format: "wallet-auth:BASE64_ENCODED_PKCS8_KEY"
 */
function parsePrivyAuthKeyToAddress(privyKey: string): string | null {
  try {
    // Remove "wallet-auth:" prefix if present
    const base64Key = privyKey.startsWith('wallet-auth:')
      ? privyKey.slice('wallet-auth:'.length)
      : privyKey

    // Decode base64 to get PKCS#8 DER bytes
    const derBytes = Buffer.from(base64Key, 'base64')

    // PKCS#8 structure for secp256k1:
    // SEQUENCE {
    //   INTEGER 0 (version)
    //   SEQUENCE { OID ecPublicKey, OID secp256k1 }
    //   OCTET STRING containing ECPrivateKey
    // }
    // The raw 32-byte private key is typically at offset 36 in the DER structure
    // But let's be more robust and look for it

    // For secp256k1 PKCS#8, the private key is usually at a specific offset
    // The structure is: 30 81 87 02 01 00 30 13 06 07 ... 04 21 00 [32 bytes key]
    // Or without the leading zero: 04 20 [32 bytes key]

    // Find the raw key bytes - look for the pattern
    let privateKeyBytes: Buffer | null = null

    // Try to find 04 20 or 04 21 00 followed by 32 bytes
    for (let i = 0; i < derBytes.length - 33; i++) {
      if (derBytes[i] === 0x04 && derBytes[i + 1] === 0x20) {
        // 04 20 [32 bytes]
        privateKeyBytes = derBytes.slice(i + 2, i + 34)
        break
      }
      if (derBytes[i] === 0x04 && derBytes[i + 1] === 0x21 && derBytes[i + 2] === 0x00) {
        // 04 21 00 [32 bytes]
        privateKeyBytes = derBytes.slice(i + 3, i + 35)
        break
      }
    }

    if (!privateKeyBytes || privateKeyBytes.length !== 32) {
      console.error('[privy] Could not extract 32-byte private key from PKCS#8')
      return null
    }

    return privateKeyToAddress(privateKeyBytes.toString('hex'))
  } catch (error) {
    console.error('[privy] Failed to parse Privy auth key:', error)
    return null
  }
}

/**
 * Get the address corresponding to the authorization private key
 * This is the address that signs on behalf of user wallets
 */
export function getAuthorizationKeyAddress(): string | null {
  if (!privyAuthKey) return null

  // Check if it's Privy's PKCS#8 format
  if (privyAuthKey.startsWith('wallet-auth:')) {
    return parsePrivyAuthKeyToAddress(privyAuthKey)
  }

  // Otherwise assume it's a raw hex key
  try {
    return privateKeyToAddress(privyAuthKey)
  } catch (error) {
    console.error('[privy] Failed to derive address from auth key:', error)
    return null
  }
}

export const privy = new PrivyClient({
  appId,
  appSecret,
})

/**
 * Get authorization context for Privy wallet operations
 */
export function getAuthorizationContext(): {
  authorization_private_keys: string[]
} {
  if (!privyAuthKey) {
    throw new Error('PRIVY_AUTH_PKEY is required but not set')
  }
  return {
    authorization_private_keys: [privyAuthKey],
  }
}

/**
 * Create an embedded Ethereum wallet for a user
 * Used when user needs an ETH wallet for Hyperliquid but doesn't have one yet
 */
export async function createEmbeddedEthWallet(userId: string): Promise<{
  address: string
  walletId: string
}> {
  const result = await privy.wallets().create({
    chain_type: 'ethereum',
    owner: { user_id: userId },
  })

  return {
    address: result.address.toLowerCase(),
    walletId: result.id,
  }
}

/**
 * Sign a message using Privy embedded wallet
 * Returns base58-encoded signature (compatible with Pacifica and Solana conventions)
 *
 * Note: Privy expects the message as base64-encoded bytes, so we convert
 * the UTF-8 string to bytes and base64 encode before sending.
 */
export async function signMessageWithPrivy(
  walletId: string,
  message: string,
  authContext?: { authorization_private_keys: string[] }
): Promise<string> {
  const context = authContext || getAuthorizationContext()

  // Convert message string to UTF-8 bytes, then base64 encode for Privy
  const messageBytes = new TextEncoder().encode(message)
  const messageBase64 = Buffer.from(messageBytes).toString('base64')

  const result = await privy.wallets().solana().signMessage(walletId, {
    message: messageBase64,
    authorization_context: context,
  })

  if (!result?.signature) {
    throw new Error('Failed to sign message with Privy')
  }

  // Privy returns base64-encoded signature, convert to base58
  const signatureBytes = Buffer.from(result.signature, 'base64')
  return bs58.encode(signatureBytes)
}

/**
 * Sign EIP-712 typed data using Privy embedded Ethereum wallet
 * Used for Hyperliquid trading operations
 *
 * Returns signature in {r, s, v} format required by Hyperliquid
 */
export async function signTypedDataWithPrivy(
  walletId: string,
  typedData: EIP712TypedData,
  authContext?: { authorization_private_keys: string[] }
): Promise<HyperliquidSignature> {
  const context = authContext || getAuthorizationContext()

  console.log(`[privy] signTypedData called with walletId: ${walletId}`)
  console.log(`[privy] primaryType: ${typedData.primaryType}`)
  console.log(`[privy] auth keys count: ${context.authorization_private_keys.length}`)

  // Pass all types including EIP712Domain to Privy (as per Privy docs)
  const privyTypes: Record<string, Array<{ name: string; type: string }>> = {}
  for (const [typeName, fields] of Object.entries(typedData.types)) {
    privyTypes[typeName] = fields
  }

  console.log(`[privy] Types being sent:`, Object.keys(privyTypes))
  console.log(`[privy] Domain:`, JSON.stringify(typedData.domain))

  try {
    // Privy EVM wallet signTypedData expects params with typed_data
    const result = await privy.wallets().ethereum().signTypedData(walletId, {
      params: {
        typed_data: {
          domain: typedData.domain as Record<string, unknown>,
          types: privyTypes,
          primary_type: typedData.primaryType,
          message: typedData.message as Record<string, unknown>,
        },
      },
      authorization_context: context,
    })

    if (!result?.signature) {
      throw new Error('Failed to sign typed data with Privy')
    }

    console.log(`[privy] Raw signature from Privy: ${result.signature}`)
    console.log(`[privy] Signature length: ${result.signature.length}`)

    // Parse the signature (0x + r(64) + s(64) + v(2))
    const sig = result.signature.startsWith('0x') ? result.signature.slice(2) : result.signature
    console.log(`[privy] Signature without 0x: ${sig}`)
    console.log(`[privy] Signature hex length: ${sig.length}`)

    const r = '0x' + sig.slice(0, 64)
    const s = '0x' + sig.slice(64, 128)
    const vHex = sig.slice(128, 130)
    const v = parseInt(vHex, 16)

    console.log(`[privy] Parsed signature:`)
    console.log(`[privy]   r: ${r}`)
    console.log(`[privy]   s: ${s}`)
    console.log(`[privy]   v (hex): ${vHex} -> (dec): ${v}`)

    // Try to recover the signer address
    try {
      const { recoverAddress } = await import('viem')
      const { hashTypedData } = await import('viem')

      // Reconstruct the typed data hash
      const messageHash = hashTypedData({
        domain: typedData.domain as any,
        types: typedData.types as any,
        primaryType: typedData.primaryType as any,
        message: typedData.message as any,
      })

      console.log(`[privy] Message hash: ${messageHash}`)

      const recoveredAddress = await recoverAddress({
        hash: messageHash,
        signature: result.signature as `0x${string}`,
      })

      console.log(`[privy] Recovered signer address: ${recoveredAddress}`)
    } catch (recoverError) {
      console.log(`[privy] Could not recover address: ${recoverError}`)
    }

    console.log(`[privy] signTypedData success for ${typedData.primaryType}`)
    return { r, s, v }
  } catch (error) {
    console.error(`[privy] signTypedData FAILED for walletId ${walletId}:`, error)
    throw error
  }
}

/**
 * Create a viem LocalAccount for a Privy embedded wallet
 * This account can be used directly for signing operations
 */
export function createPrivyViemAccount(
  walletId: string,
  address: string,
  authContext?: { authorization_private_keys: string[] }
): LocalAccount {
  const context = authContext || getAuthorizationContext()

  return privyCreateViemAccount(privy, {
    walletId,
    address: address as Hex,
    authorizationContext: {
      authorization_private_keys: context.authorization_private_keys,
    },
  })
}

/**
 * Create a sign function wrapper for Hyperliquid client using viem account
 * @deprecated Use createPrivyViemAccount and pass directly to HyperliquidClient.setViemAccount()
 */
export function createHyperliquidSignFn(
  walletId: string,
  address: string,
  authContext?: { authorization_private_keys: string[] }
): (typedData: EIP712TypedData) => Promise<HyperliquidSignature> {
  const account = createPrivyViemAccount(walletId, address, authContext)

  return async (typedData: EIP712TypedData) => {
    console.log(`[privy] signTypedData called via viem account`)
    console.log(`[privy] primaryType: ${typedData.primaryType}`)
    console.log(`[privy] Account address: ${account.address}`)

    try {
      // Use the account's signTypedData method directly
      const signature = await account.signTypedData({
        domain: typedData.domain as any,
        types: typedData.types as any,
        primaryType: typedData.primaryType as any,
        message: typedData.message as any,
      })

      console.log(`[privy] Raw signature from viem: ${signature}`)

      // Parse the signature (0x + r(64) + s(64) + v(2))
      const sig = signature.startsWith('0x') ? signature.slice(2) : signature
      const r = '0x' + sig.slice(0, 64)
      const s = '0x' + sig.slice(64, 128)
      const vHex = sig.slice(128, 130)
      const v = parseInt(vHex, 16)

      console.log(`[privy] Parsed signature: r=${r.slice(0, 20)}..., s=${s.slice(0, 20)}..., v=${v}`)
      console.log(`[privy] signTypedData success for ${typedData.primaryType}`)

      return { r, s, v }
    } catch (error) {
      console.error(`[privy] signTypedData FAILED:`, error)
      throw error
    }
  }
}

/**
 * Create a Hyperliquid-compatible viem account for a Privy embedded wallet
 * This account can be passed directly to HyperliquidClient.setViemAccount()
 */
export function createHyperliquidViemAccount(
  walletId: string,
  address: string,
  authContext?: { authorization_private_keys: string[] }
): LocalAccount {
  return createPrivyViemAccount(walletId, address, authContext)
}

/**
 * Get wallet info by ID from Privy
 * Use this to verify the actual address for a wallet ID
 */
export async function getWalletById(walletId: string): Promise<{
  id: string
  address: string
  chainType: string
} | null> {
  try {
    const wallet = await privy.wallets().get(walletId)
    return {
      id: wallet.id,
      address: wallet.address.toLowerCase(),
      chainType: wallet.chain_type,
    }
  } catch (error) {
    console.error(`[privy] Failed to get wallet ${walletId}:`, error)
    return null
  }
}
