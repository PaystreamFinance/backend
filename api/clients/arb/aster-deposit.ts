import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { createHash } from 'crypto'
import { USDT_MINT as USDT_MINT_ADDRESS, USDT_DECIMALS } from '../../utils/constants'

// Aster program constants
const PROGRAM_ID = new PublicKey('EhUtRgu9iEbZXXRpEvDj6n1wnQRjMi2SERDo3c6bmN2c')
const ADMIN = new PublicKey('3WS5gZL6gqqkxuKp1cFPsd2tvbrkwjGEJbLRZ2uiY5x2')

// USDT asset config
const USDT_BANK = new PublicKey('At2UJcLiStb6PPhgFMcwovkBecwjocAWEAaDm9gcPoGF')
const USDT_TOKEN_VAULT_AUTHORITY = new PublicKey('2kzXy9ZRPKSBLQH3QQRX9wiHzdJes78wdwdsck9q3vPv')
const USDT_TOKEN_VAULT = new PublicKey('3oEw1xjhLvKS5k4CqFGcEPhKHEa3tkz5xK6wJcTGFqES')
const USDT_MINT = new PublicKey(USDT_MINT_ADDRESS)

/**
 * Get Anchor instruction discriminator (first 8 bytes of SHA-256("global:<instruction_name>"))
 */
function anchorDiscriminator(instructionName: string): Buffer {
  const hash = createHash('sha256').update(`global:${instructionName}`).digest()
  return hash.subarray(0, 8)
}

/**
 * Build an Aster deposit transaction using the deposit_token program instruction (USDT only)
 */
export async function buildAsterDepositTransaction(
  walletPubkey: PublicKey,
  amount: number,
): Promise<{ transaction: Transaction; vaultAddress: string }> {
  const userTokenAccount = await getAssociatedTokenAddress(USDT_MINT, walletPubkey)

  // Instruction data: 8-byte discriminator + 8-byte u64 amount (little-endian)
  const discriminator = anchorDiscriminator('deposit_token')
  const amountSmallest = BigInt(Math.floor(amount * Math.pow(10, USDT_DECIMALS)))
  const amountBuffer = Buffer.alloc(8)
  amountBuffer.writeBigUInt64LE(amountSmallest)
  const data = Buffer.concat([discriminator, amountBuffer])

  const keys = [
    { pubkey: walletPubkey, isSigner: true, isWritable: true },         // signer
    { pubkey: ADMIN, isSigner: false, isWritable: false },               // admin
    { pubkey: USDT_BANK, isSigner: false, isWritable: false },           // bank
    { pubkey: USDT_TOKEN_VAULT_AUTHORITY, isSigner: false, isWritable: false }, // tokenVaultAuthority
    { pubkey: USDT_TOKEN_VAULT, isSigner: false, isWritable: true },     // tokenVault
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },     // userTokenAccount
    { pubkey: USDT_MINT, isSigner: false, isWritable: false },           // tokenMint
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },    // tokenProgram
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // associatedTokenProgram
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },     // systemProgram
  ]

  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data,
  })

  const tx = new Transaction()
  tx.feePayer = walletPubkey
  tx.add(instruction)

  return { transaction: tx, vaultAddress: USDT_TOKEN_VAULT.toBase58() }
}
