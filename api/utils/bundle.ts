import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js'
import { connection } from '../clients/solana'
import { privy } from '../clients/privy'
import { log } from './log'
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types'
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher'
import { status } from '@grpc/grpc-js'
import { getTipAccount } from './tipAccounts'
import { HELIUS_RPC_URL, HELIUS_API_KEY, LOG_SIMULATION, JITO_ENDPOINTS, JITO_AUTH_KEYPAIR } from './constants'

/** Default Jito tip: 0.0001 SOL */
const DEFAULT_TIP_LAMPORTS = 100_000

const getJitoBundleApiUrl = (endpoint?: string) => {
  const baseEndpoint = endpoint || JITO_ENDPOINTS[0]
  return `https://${baseEndpoint}/api/v1/bundles`
}

export interface BundleResult {
  bundleId: string
  confirmed: boolean
  txSignatures: string[]
  error?: string
}

function isRateLimitError(result: any): boolean {
  if (!result || result.ok) return false
  if (result.err?.code === status.RESOURCE_EXHAUSTED) return true
  if (result.err?.status === 429 || result.status === 429) return true
  const s = JSON.stringify(result).toLowerCase()
  return s.includes('rate limit') || s.includes('429') || s.includes('resource exhausted')
}

/**
 * Send a bundle with auto-retry across Jito endpoints on rate limit
 */
async function sendBundleWithRetry(bundle: Bundle, logPrefix: string): Promise<string> {
  let lastError: any = null

  for (let i = 0; i < JITO_ENDPOINTS.length; i++) {
    const endpoint = JITO_ENDPOINTS[i]
    const client = JITO_AUTH_KEYPAIR
      ? searcherClient(endpoint, JITO_AUTH_KEYPAIR)
      : searcherClient(endpoint)

    try {
      log.info(`${logPrefix} Sending bundle to ${endpoint} (${i + 1}/${JITO_ENDPOINTS.length})`)
      const result = await client.sendBundle(bundle)

      if (result.ok && result.value) {
        log.info(`${logPrefix} Bundle ID: ${result.value}`)
        return result.value
      }

      if (isRateLimitError(result)) {
        log.warn(`${logPrefix} Rate limited by ${endpoint}, trying next...`)
        lastError = result
        continue
      }

      throw new Error(`Failed to send bundle: ${JSON.stringify(result)}`)
    } catch (error: any) {
      const msg = (error?.message || JSON.stringify(error)).toLowerCase()
      if (msg.includes('rate limit') || msg.includes('429')) {
        log.warn(`${logPrefix} Rate limit from ${endpoint}, trying next...`)
        lastError = error
        continue
      }
      throw error
    }
  }

  throw new Error(`Bundle rejected by all Jito endpoints. Last error: ${JSON.stringify(lastError)}`)
}

/**
 * Check bundle status via Jito API
 */
async function getBundleStatus(
  bundleId: string,
  logPrefix: string,
  endpoint?: string
): Promise<{ status: 'pending' | 'confirmed' | 'finalized' | 'failed' | 'not_found'; transactions?: string[] }> {
  const apiUrl = getJitoBundleApiUrl(endpoint)

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleId]],
      }),
    })

    if (response.status === 429) {
      log.warn(`${logPrefix} Rate limited checking bundle status`)
      if (endpoint) {
        const idx = JITO_ENDPOINTS.indexOf(endpoint)
        if (idx >= 0 && idx < JITO_ENDPOINTS.length - 1) {
          return getBundleStatus(bundleId, logPrefix, JITO_ENDPOINTS[idx + 1])
        }
      }
      return { status: 'not_found' }
    }

    if (!response.ok) return { status: 'not_found' }

    const data = await response.json()
    const result = data?.result?.value?.[0]
    if (!result) return { status: 'not_found' }

    const s = result.confirmation_status
    if (s === 'finalized' || s === 'confirmed' || s === 'landed') {
      return { status: s === 'landed' ? 'confirmed' : s, transactions: result.transactions || [] }
    }
    if (result.err?.Ok === null) return { status: 'pending' }
    if (result.err) return { status: 'failed' }
    return { status: 'pending' }
  } catch (error) {
    log.error(`${logPrefix} Failed to get bundle status:`, error)
    return { status: 'not_found' }
  }
}

/**
 * Poll for bundle confirmation
 */
async function waitForBundleConfirmation(
  bundleId: string,
  maxAttempts: number,
  delayMs: number,
  logPrefix: string
): Promise<{ confirmed: boolean; txSignatures: string[] }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await getBundleStatus(bundleId, logPrefix)

    if (result.status === 'confirmed' || result.status === 'finalized') {
      log.info(`${logPrefix} Bundle confirmed after ${attempt} attempts`)
      return { confirmed: true, txSignatures: result.transactions || [] }
    }
    if (result.status === 'failed') {
      log.error(`${logPrefix} Bundle failed`)
      return { confirmed: false, txSignatures: [] }
    }

    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, delayMs))
    }
  }

  log.warn(`${logPrefix} Bundle confirmation timeout after ${maxAttempts} attempts`)
  return { confirmed: false, txSignatures: [] }
}

/**
 * Create a Jito tip instruction
 */
function createTipInstruction(
  walletPubkey: PublicKey,
  tipLamports?: number
): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: walletPubkey,
    toPubkey: getTipAccount(),
    lamports: tipLamports ?? DEFAULT_TIP_LAMPORTS,
  })
}

/**
 * Simulate bundle via Helius RPC (optional, requires HELIUS_API_KEY)
 */
async function simulateBundle(
  encodedTransactions: string[],
  logPrefix: string
): Promise<{ ok: boolean; error?: string }> {
  if (!HELIUS_API_KEY) return { ok: true } // skip if no key

  try {
    const response = await fetch(`${HELIUS_RPC_URL}?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'simulateBundle',
        params: [{
          encodedTransactions,
          transactionEncoding: 'base64',
          replaceRecentBlockhash: true,
          skipSigVerify: true,
        }],
      }),
    })

    if (!response.ok) return { ok: true } // skip on HTTP error

    const json = await response.json()
    if (json.error) return { ok: true } // skip on RPC error

    const summary = json.result?.value?.summary
    if (typeof summary === 'object' && summary?.failed) {
      const failedTx = summary.failed
      const error = failedTx.error

      let message = 'Bundle simulation failed. '
      if (Array.isArray(error) && error.length >= 2 && typeof error[1] === 'string') {
        const msg = error[1]
        if (msg.includes('custom program error: 0x1') || msg.includes('insufficient lamports')) {
          message += 'Insufficient SOL for rent or fees.'
        } else if (msg.includes('Computational budget exceeded')) {
          message += 'Transaction exceeded compute budget.'
        } else {
          message += `Transaction error: ${msg}`
        }
      } else {
        message += 'Check wallet balance and try again.'
      }

      return { ok: false, error: message }
    }

    if (LOG_SIMULATION) {
      log.info(`${logPrefix} Bundle simulation passed`)
    }
    return { ok: true }
  } catch {
    return { ok: true } // skip on network error
  }
}

/**
 * Bundle transactions, sign via Privy, simulate, send via Jito, and wait for confirmation.
 *
 * @param transactions - Solana transactions to bundle (tip is appended to the last one)
 * @param walletPubkey - Fee payer public key
 * @param embeddedWalletId - Privy wallet ID for signing
 * @param authContext - Privy authorization context
 * @param tipLamports - Jito tip amount (default: 0.0001 SOL)
 * @param logPrefix - Log prefix for tracing
 */
export async function bundleAndConfirm(
  transactions: Array<Transaction | VersionedTransaction>,
  walletPubkey: PublicKey,
  embeddedWalletId: string,
  authContext: any,
  tipLamports?: number,
  logPrefix: string = '[bundle]',
  confirmationMaxAttempts: number = 30,
  confirmationDelayMs: number = 2000,
): Promise<BundleResult> {
  if (transactions.length === 0) {
    return { bundleId: '', confirmed: false, txSignatures: [], error: 'No transactions' }
  }

  try {
    // Get shared blockhash
    const { blockhash } = await connection.getLatestBlockhash('finalized')

    // Process transactions: update blockhash, append tip to last tx
    const processedTxs: Array<Transaction | VersionedTransaction> = []

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i]
      const isLast = i === transactions.length - 1

      if (tx instanceof VersionedTransaction) {
        // Decompile, update blockhash, add tip if last, recompile
        const altResponses = await Promise.all(
          tx.message.addressTableLookups.map(l => connection.getAddressLookupTable(l.accountKey))
        )
        const alts = altResponses.map(r => {
          if (!r.value) throw new Error('Address lookup table not found')
          return r.value
        })

        const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: alts })
        msg.recentBlockhash = blockhash
        if (isLast) msg.instructions.push(createTipInstruction(walletPubkey, tipLamports))

        processedTxs.push(new VersionedTransaction(msg.compileToV0Message(alts)))
      } else {
        tx.signatures = []
        tx.recentBlockhash = blockhash
        tx.feePayer = walletPubkey
        if (isLast) tx.add(createTipInstruction(walletPubkey, tipLamports))

        processedTxs.push(tx)
      }
    }

    // Serialize and sign all via Privy
    const serialized = processedTxs.map(tx =>
      tx instanceof VersionedTransaction
        ? Buffer.from(tx.serialize()).toString('base64')
        : Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64')
    )

    const signed = await Promise.all(
      serialized.map(s =>
        privy.wallets().solana().signTransaction(embeddedWalletId, {
          transaction: s,
          authorization_context: authContext,
        })
      )
    )

    const signedTxs = signed.map(s =>
      VersionedTransaction.deserialize(Buffer.from(s.signed_transaction!, 'base64'))
    )

    // Simulate
    const encoded = signedTxs.map(tx => Buffer.from(tx.serialize()).toString('base64'))
    const sim = await simulateBundle(encoded, logPrefix)
    if (!sim.ok) {
      return { bundleId: '', confirmed: false, txSignatures: [], error: sim.error }
    }

    // Send
    const bundle = new Bundle([], transactions.length)
    bundle.addTransactions(...signedTxs)
    const bundleId = await sendBundleWithRetry(bundle, logPrefix)

    // Confirm
    const confirmation = await waitForBundleConfirmation(bundleId, confirmationMaxAttempts, confirmationDelayMs, logPrefix)

    return {
      bundleId,
      confirmed: confirmation.confirmed,
      txSignatures: confirmation.txSignatures,
      error: confirmation.confirmed ? undefined : 'Bundle not confirmed',
    }
  } catch (error) {
    return {
      bundleId: '',
      confirmed: false,
      txSignatures: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
