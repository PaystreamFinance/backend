import { Nord, NordUser } from '@n1xyz/nord-ts'
import { PublicKey, Transaction, Keypair } from '@solana/web3.js'
import * as nacl from 'tweetnacl'
import { connection } from '../solana'
import { privy } from '../privy'
import { serializeTransactionForPrivy } from '../../utils/transaction'
import { getOrCreateZoSession } from './zo-auth'
import { log } from '../../utils/log'

const ZO_WEB_URL = 'https://zo-mainnet.n1.xyz'

// Nord "app" pubkey identifies the on-chain protocol instance. Fetched once
// from /proton/v0/config — verified stable on mainnet as of 2026-04-17.
const ZO_APP_PUBKEY = 'zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5'

let nordPromise: Promise<Nord> | null = null

async function getNord(): Promise<Nord> {
  if (!nordPromise) {
    log.info('[zo-sdk] Initializing Nord client...')
    nordPromise = Nord.new({
      app: ZO_APP_PUBKEY,
      solanaConnection: connection,
      webServerUrl: ZO_WEB_URL,
    }).catch(err => {
      nordPromise = null
      throw err
    })
  }
  return nordPromise
}

interface PrivyWallet {
  walletId: string
  address: string
}

interface AuthContext {
  authorization_private_keys: string[]
}

function buildPrivySigners(embeddedWallet: PrivyWallet, authContext: AuthContext) {
  const signMessageFn = async (utf8: Uint8Array): Promise<Uint8Array> => {
    const messageBase64 = Buffer.from(utf8).toString('base64')
    const result = await privy.wallets().solana().signMessage(embeddedWallet.walletId, {
      message: messageBase64,
      authorization_context: authContext,
    })
    if (!result?.signature) throw new Error('Privy did not return a signature')
    return new Uint8Array(Buffer.from(result.signature, 'base64'))
  }

  const signTransactionFn = async (tx: Transaction): Promise<Transaction> => {
    const serialized = serializeTransactionForPrivy(tx)
    const result = await privy.wallets().solana().signTransaction(embeddedWallet.walletId, {
      transaction: serialized,
      authorization_context: authContext,
    })
    if (!result.signed_transaction) throw new Error('Privy did not return a signed transaction')
    return Transaction.from(Buffer.from(result.signed_transaction, 'base64'))
  }

  return { signMessageFn, signTransactionFn }
}

export interface ZoNordUserParams {
  privyUserId: string
  embeddedWallet: PrivyWallet
  authContext: AuthContext
}

/**
 * NordUser for deposit. Generates an ephemeral session key that is never
 * registered on-chain — `deposit()` only calls `signTransactionFn`, so
 * skipping the CreateSession round-trip matters on first-ever-deposit UX.
 */
export async function createZoNordUserForDeposit({
  embeddedWallet,
  authContext,
}: Omit<ZoNordUserParams, 'privyUserId'>): Promise<NordUser> {
  const nord = await getNord()
  const walletPubkey = new PublicKey(embeddedWallet.address)
  const ephemeralSession = Keypair.generate()
  const { signMessageFn, signTransactionFn } = buildPrivySigners(embeddedWallet, authContext)
  const signSessionFn = async (): Promise<Uint8Array> => {
    throw new Error('signSessionFn unavailable on deposit-only NordUser')
  }
  return NordUser.new({
    nord,
    walletPubkey,
    sessionPubkey: ephemeralSession.publicKey.toBytes(),
    signMessageFn,
    signTransactionFn,
    signSessionFn,
  })
}

/**
 * NordUser backed by a real registered session — required for `withdraw()`
 * and other `submitSessionAction`-based flows. Bootstraps the session via
 * the existing zo-auth helper if one isn't already active.
 */
export async function createZoNordUserForWithdraw({
  privyUserId,
  embeddedWallet,
  authContext,
}: ZoNordUserParams): Promise<NordUser> {
  const [nord, session] = await Promise.all([
    getNord(),
    getOrCreateZoSession(privyUserId, embeddedWallet.walletId, embeddedWallet.address, authContext),
  ])

  const walletPubkey = new PublicKey(embeddedWallet.address)
  const sessionKeypair = Keypair.fromSecretKey(session.sessionSecretKey)
  const { signMessageFn, signTransactionFn } = buildPrivySigners(embeddedWallet, authContext)
  const signSessionFn = async (raw: Uint8Array): Promise<Uint8Array> => {
    return nacl.sign.detached(raw, session.sessionSecretKey)
  }

  return NordUser.new({
    nord,
    walletPubkey,
    sessionPubkey: sessionKeypair.publicKey.toBytes(),
    sessionId: session.sessionId,
    signMessageFn,
    signTransactionFn,
    signSessionFn,
  })
}
