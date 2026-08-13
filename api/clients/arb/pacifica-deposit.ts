import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Connection,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { createHash } from 'crypto'
import { SOLANA_RPC_URL } from '../../utils/constants'
import { log } from '../../utils/log'

// Pacifica program constants
export const PACIFICA_PROGRAM_ID = new PublicKey('PCFA5iYgmqK6MqPhWNKg7Yv7auX7VZ4Cx7T1eJyrAMH')
export const PACIFICA_CENTRAL_STATE = new PublicKey('9Gdmhq4Gv1LnNMp7aiS1HSVd7pNnXNMsbuXALCQRmGjY')
export const PACIFICA_VAULT = new PublicKey('72R843XwZxqWhsJceARQQTTbYtWy6Zw9et2YV4FpRHTa')
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

// Cached event authority PDA (derived once)
let cachedEventAuthority: PublicKey | null = null

/**
 * Get instruction discriminator (first 8 bytes of SHA256("global:instruction_name"))
 */
function getDiscriminator(instructionName: string): Buffer {
  const hash = createHash('sha256').update(`global:${instructionName}`).digest()
  return hash.slice(0, 8)
}

// Pre-compute deposit discriminator
const DEPOSIT_DISCRIMINATOR = getDiscriminator('deposit')
const WITHDRAW_DISCRIMINATOR = getDiscriminator('withdraw')

/**
 * Get event authority PDA for Pacifica program (cached)
 */
async function getEventAuthority(): Promise<PublicKey> {
  if (cachedEventAuthority) {
    return cachedEventAuthority
  }
  const [eventAuthority] = await PublicKey.findProgramAddress(
    [Buffer.from('__event_authority')],
    PACIFICA_PROGRAM_ID
  )
  cachedEventAuthority = eventAuthority
  return eventAuthority
}

/**
 * Build deposit instruction data
 * Format: discriminator (8 bytes) + amount (u64, 8 bytes little-endian)
 */
function buildDepositInstructionData(amountUsdc: number): Buffer {
  // Convert to 6 decimals (USDC)
  const amountScaled = BigInt(Math.round(amountUsdc * 1_000_000))

  // Amount as little-endian u64
  const amountBuffer = Buffer.alloc(8)
  amountBuffer.writeBigUInt64LE(amountScaled, 0)

  return Buffer.concat([DEPOSIT_DISCRIMINATOR, amountBuffer])
}

export interface PacificaDepositResult {
  transaction: Transaction
  amount: number
  amountScaled: bigint
  vaultAddress: string
}

/**
 * Build a Pacifica deposit transaction
 * Deposits USDC from user's wallet to Pacifica vault
 */
export async function buildPacificaDepositTransaction(
  walletPubkey: PublicKey,
  amountUsdc: number
): Promise<PacificaDepositResult> {
  log.info(`[pacifica-deposit] Building deposit tx for ${amountUsdc} USDC`)

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed')

  // Get user's USDC associated token address and event authority in parallel
  const [userUsdcAta, eventAuthority] = await Promise.all([
    getAssociatedTokenAddress(USDC_MINT, walletPubkey),
    getEventAuthority(),
  ])

  // Build instruction accounts (10 accounts as per Pacifica spec)
  const keys = [
    { pubkey: walletPubkey, isSigner: true, isWritable: true },           // depositor
    { pubkey: userUsdcAta, isSigner: false, isWritable: true },           // depositorUsdcAccount
    { pubkey: PACIFICA_CENTRAL_STATE, isSigner: false, isWritable: true }, // centralState
    { pubkey: PACIFICA_VAULT, isSigner: false, isWritable: true },        // vault
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // tokenProgram
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // associatedTokenProgram
    { pubkey: USDC_MINT, isSigner: false, isWritable: false },            // usdcMint
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // systemProgram
    { pubkey: eventAuthority, isSigner: false, isWritable: false },       // eventAuthority
    { pubkey: PACIFICA_PROGRAM_ID, isSigner: false, isWritable: false },  // program (self)
  ]

  // Build instruction data
  const data = buildDepositInstructionData(amountUsdc)

  // Create instruction
  const instruction = new TransactionInstruction({
    programId: PACIFICA_PROGRAM_ID,
    keys,
    data,
  })

  // Create transaction
  const transaction = new Transaction().add(instruction)

  // Set fee payer first
  transaction.feePayer = walletPubkey

  // Get blockhash with 'finalized' commitment for stability (less likely to expire)
  const { blockhash } = await connection.getLatestBlockhash('finalized')
  transaction.recentBlockhash = blockhash

  log.info(`[pacifica-deposit] Built deposit transaction for ${amountUsdc} USDC (blockhash: ${blockhash.slice(0, 8)}...)`)

  return {
    transaction,
    amount: amountUsdc,
    amountScaled: BigInt(Math.round(amountUsdc * 1_000_000)),
    vaultAddress: PACIFICA_VAULT.toBase58(),
  }
}

/**
 * Build withdraw instruction data
 * Format: discriminator (8 bytes) + amount (u64, 8 bytes little-endian)
 */
function buildWithdrawInstructionData(amountUsdc: number): Buffer {
  // Convert to 6 decimals (USDC)
  const amountScaled = BigInt(Math.round(amountUsdc * 1_000_000))

  // Amount as little-endian u64
  const amountBuffer = Buffer.alloc(8)
  amountBuffer.writeBigUInt64LE(amountScaled, 0)

  return Buffer.concat([WITHDRAW_DISCRIMINATOR, amountBuffer])
}

export interface PacificaWithdrawResult {
  transaction: Transaction
  amount: number
  amountScaled: bigint
}

/**
 * Build a Pacifica withdraw transaction (on-chain part)
 * Note: Withdrawals on Pacifica may require REST API call instead of/in addition to on-chain tx
 */
export async function buildPacificaWithdrawTransaction(
  walletPubkey: PublicKey,
  amountUsdc: number
): Promise<PacificaWithdrawResult> {
  log.info(`[pacifica-withdraw] Building withdraw tx for ${amountUsdc} USDC`)

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed')

  // Get user's USDC associated token address and event authority in parallel
  const [userUsdcAta, eventAuthority] = await Promise.all([
    getAssociatedTokenAddress(USDC_MINT, walletPubkey),
    getEventAuthority(),
  ])

  // Build instruction accounts (similar to deposit but with withdrawal accounts)
  const keys = [
    { pubkey: walletPubkey, isSigner: true, isWritable: true },           // withdrawer
    { pubkey: userUsdcAta, isSigner: false, isWritable: true },           // withdrawerUsdcAccount
    { pubkey: PACIFICA_CENTRAL_STATE, isSigner: false, isWritable: true }, // centralState
    { pubkey: PACIFICA_VAULT, isSigner: false, isWritable: true },        // vault
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // tokenProgram
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // associatedTokenProgram
    { pubkey: USDC_MINT, isSigner: false, isWritable: false },            // usdcMint
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // systemProgram
    { pubkey: eventAuthority, isSigner: false, isWritable: false },       // eventAuthority
    { pubkey: PACIFICA_PROGRAM_ID, isSigner: false, isWritable: false },  // program (self)
  ]

  // Build instruction data
  const data = buildWithdrawInstructionData(amountUsdc)

  // Create instruction
  const instruction = new TransactionInstruction({
    programId: PACIFICA_PROGRAM_ID,
    keys,
    data,
  })

  // Create transaction
  const transaction = new Transaction().add(instruction)

  // Set fee payer first
  transaction.feePayer = walletPubkey

  // Get blockhash with 'finalized' commitment for stability
  const { blockhash } = await connection.getLatestBlockhash('finalized')
  transaction.recentBlockhash = blockhash

  log.info(`[pacifica-withdraw] Built withdraw transaction for ${amountUsdc} USDC (blockhash: ${blockhash.slice(0, 8)}...)`)

  return {
    transaction,
    amount: amountUsdc,
    amountScaled: BigInt(Math.round(amountUsdc * 1_000_000)),
  }
}
