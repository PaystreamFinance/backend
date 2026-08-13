import { db } from '@paystream/db'
import { exchangeApiKeys } from '@paystream/db/schema'
import { and, eq } from 'drizzle-orm'
import * as bs58 from 'bs58'
import {
  loadZoSchema,
  encodeAction,
  decodeReceipt,
  packEnvelope,
  generateZoSessionKeypair,
  keypairFromSecret,
  hexEncode,
} from '@paystream/perps/clients/zo-codec'
import { ZoClient, createZoClient, ZO_SESSION_TTL_SEC } from '@paystream/perps/clients/zo-client'
import type { ZoSessionCreds } from '@paystream/perps/providers/zo-provider'
import { signMessageWithPrivy } from '../privy'
import { log } from '../../utils/log'
import { isZoSessionError } from './zo-errors'

/** Persisted shape stored in exchange_api_keys.credentials for 01. */
interface ZoStoredCreds {
  sessionId: string            // stored as decimal string; BigInt isn't JSON-safe
  sessionSecretKey: string     // base58(64-byte nacl secretKey)
  accountId: number
  expiryTimestamp: string      // unix seconds, decimal string
}

// In-memory cache keyed by privyUserId.
const credentialStore = new Map<string, ZoSessionCreds>()

// Dedupe concurrent bootstraps so racing requests don't create split sessions
// on Nord (one per winner of the race) — the loser's session becomes orphaned.
const inflightSessions = new Map<string, Promise<ZoSessionCreds>>()

function toCreds(stored: ZoStoredCreds): ZoSessionCreds {
  return {
    sessionId: BigInt(stored.sessionId),
    sessionSecretKey: bs58.decode(stored.sessionSecretKey),
    accountId: stored.accountId,
    expiryTimestamp: BigInt(stored.expiryTimestamp),
  }
}

function fromCreds(creds: ZoSessionCreds): ZoStoredCreds {
  return {
    sessionId: creds.sessionId.toString(),
    sessionSecretKey: bs58.encode(creds.sessionSecretKey),
    accountId: creds.accountId,
    expiryTimestamp: creds.expiryTimestamp.toString(),
  }
}

function isActive(creds: ZoSessionCreds): boolean {
  // Treat a session as "expiring soon" if <2 min left; force rotation.
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  return creds.expiryTimestamp > nowSec + 120n
}

/**
 * Get cached 01 session creds or run the CreateSession flow.
 *
 * Flow (see schema.proto § signature scheme "user_sign"):
 *   1. Cache → DB
 *   2. /user/{pubkey} → accountIds[0]  (user must have deposited to 01 first)
 *   3. Generate ephemeral session keypair locally
 *   4. Fetch /timestamp
 *   5. Build Action.CreateSession { userPubkey, sessionPubkey, expiryTimestamp }
 *   6. encodeAction → raw bytes (length-delimited)
 *   7. signMessageWithPrivy(walletId, hex(raw)) → base58 sig
 *   8. packEnvelope(raw, sig) → POST /action → Receipt
 *   9. Extract sessionId from CreateSessionResult; persist
 */
export async function getOrCreateZoSession(
  privyUserId: string,
  solanaWalletId: string,
  solanaWalletAddress: string,
  authContext: { authorization_private_keys: string[] },
): Promise<ZoSessionCreds> {
  const cached = credentialStore.get(privyUserId)
  if (cached && isActive(cached)) return cached
  if (cached && !isActive(cached)) credentialStore.delete(privyUserId)

  const inflight = inflightSessions.get(privyUserId)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      return await bootstrapZoSession(privyUserId, solanaWalletId, solanaWalletAddress, authContext)
    } finally {
      inflightSessions.delete(privyUserId)
    }
  })()
  inflightSessions.set(privyUserId, promise)
  return promise
}

async function bootstrapZoSession(
  privyUserId: string,
  solanaWalletId: string,
  solanaWalletAddress: string,
  authContext: { authorization_private_keys: string[] },
): Promise<ZoSessionCreds> {
  const [dbRecord] = await db.select().from(exchangeApiKeys)
    .where(and(eq(exchangeApiKeys.privyUserId, privyUserId), eq(exchangeApiKeys.exchange, '01')))
    .limit(1)

  if (dbRecord?.isActive) {
    const stored = dbRecord.credentials as unknown as ZoStoredCreds
    if (stored?.sessionId && stored?.sessionSecretKey) {
      const creds = toCreds(stored)
      if (isActive(creds)) {
        credentialStore.set(privyUserId, creds)
        await db.update(exchangeApiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(exchangeApiKeys.id, dbRecord.id))
          .catch(() => {})
        log.info(`[zo-auth] Loaded session from DB for ${privyUserId} (sid=${creds.sessionId})`)
        return creds
      }
      log.info(`[zo-auth] DB session expired for ${privyUserId}, will rotate`)
    }
  }

  log.info(`[zo-auth] No active 01 session for ${privyUserId}, starting CreateSession flow`)

  const client = createZoClient()

  // 3. Resolve Nord accountId. User must have deposited before trading.
  const userInfo = await client.getUserInfo(solanaWalletAddress)
  if (!userInfo || !userInfo.accountIds || userInfo.accountIds.length === 0) {
    throw new Error('No 01 account found. Please deposit funds to 01 first.')
  }
  const accountId = userInfo.accountIds[0]
  log.info(`[zo-auth] Using 01 accountId=${accountId} for ${solanaWalletAddress}`)

  // 4. Generate session key
  const sessionKeypair = generateZoSessionKeypair()

  // 5. Build & sign CreateSession
  const proto = await loadZoSchema()
  const serverTs = await client.getTimestamp()
  const expiryTs = serverTs + BigInt(ZO_SESSION_TTL_SEC)
  const solanaPubkeyBytes = bs58.decode(solanaWalletAddress)
  if (solanaPubkeyBytes.length !== 32) {
    throw new Error(`Invalid Solana pubkey length: ${solanaPubkeyBytes.length}`)
  }

  const raw = encodeAction(proto, {
    currentTimestamp: serverTs,
    createSession: {
      userPubkey: solanaPubkeyBytes,
      sessionPubkey: sessionKeypair.publicKey,
      expiryTimestamp: expiryTs,
    },
  })

  // 6. user_sign = ed25519_sign(hex(raw)) — Privy signs the ASCII hex string.
  const hexMessage = hexEncode(raw)
  const signatureBase58 = await signMessageWithPrivy(solanaWalletId, hexMessage, authContext)
  const signature = bs58.decode(signatureBase58)
  if (signature.length !== 64) {
    throw new Error(`Expected 64-byte signature from Privy, got ${signature.length}`)
  }

  // 7. Envelope + submit
  const envelope = packEnvelope(raw, signature)
  log.info(`[zo-auth] Submitting CreateSession (${envelope.length} bytes) for account=${accountId}`)
  const receiptBytes = await client.submitAction(envelope)
  const receipt = decodeReceipt(proto, receiptBytes)

  const sessionId = extractSessionId(receipt)
  if (sessionId === null) {
    throw new Error(`01 CreateSession: no sessionId in receipt: ${JSON.stringify(receipt).slice(0, 300)}`)
  }

  const creds: ZoSessionCreds = {
    sessionId,
    sessionSecretKey: sessionKeypair.secretKey,
    accountId,
    expiryTimestamp: expiryTs,
  }

  // 8. Persist
  await db.insert(exchangeApiKeys)
    .values({
      privyUserId,
      walletAddress: solanaWalletAddress,
      exchange: '01',
      credentials: fromCreds(creds) as unknown as Record<string, unknown>,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [exchangeApiKeys.privyUserId, exchangeApiKeys.exchange],
      set: {
        credentials: fromCreds(creds) as unknown as Record<string, unknown>,
        walletAddress: solanaWalletAddress,
        isActive: true,
        updatedAt: new Date(),
      },
    })

  credentialStore.set(privyUserId, creds)
  log.info(`[zo-auth] Created 01 session sessionId=${sessionId} expiry=${new Date(Number(expiryTs) * 1000).toISOString()}`)
  return creds
}

/**
 * Read the already-stored session creds without triggering a Privy round-trip.
 * Returns null if no active session exists or it has expired.
 */
export async function getStoredZoSessionAsync(privyUserId: string): Promise<ZoSessionCreds | null> {
  const cached = credentialStore.get(privyUserId)
  if (cached && isActive(cached)) return cached

  const [dbRecord] = await db.select().from(exchangeApiKeys)
    .where(and(eq(exchangeApiKeys.privyUserId, privyUserId), eq(exchangeApiKeys.exchange, '01')))
    .limit(1)

  if (!dbRecord?.isActive) return null
  const stored = dbRecord.credentials as unknown as ZoStoredCreds
  if (!stored?.sessionId || !stored?.sessionSecretKey) return null
  const creds = toCreds(stored)
  if (!isActive(creds)) return null

  credentialStore.set(privyUserId, creds)
  return creds
}

export async function invalidateZoSession(privyUserId: string): Promise<void> {
  credentialStore.delete(privyUserId)
  // Await so the DB write is attempted before we return, but swallow failures —
  // the in-memory cache is already cleared and the next cold pod will rehydrate.
  await db.update(exchangeApiKeys)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(exchangeApiKeys.privyUserId, privyUserId), eq(exchangeApiKeys.exchange, '01')))
    .catch(e => log.error('[zo-auth] Failed to invalidate DB session:', e))
  log.info(`[zo-auth] Invalidated 01 session for ${privyUserId}`)
}

/**
 * Run a session-signed 01 operation and invalidate the cached session on
 * session-rejection errors so the next call bootstraps a fresh one. Does NOT
 * retry — caller decides whether to surface the failure or retry manually.
 */
export async function runWithZoSessionInvalidation<T>(
  privyUserId: string,
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await op()
  } catch (err) {
    if (isZoSessionError(err)) {
      log.warn(`[zo-auth] 01 session rejected for ${privyUserId}, invalidating`)
      await invalidateZoSession(privyUserId)
    }
    throw err
  }
}

/**
 * Dig sessionId out of a decoded Receipt. The Nord Receipt shape varies by
 * protobufjs decoding style (camelCase vs snake_case) and by whether the
 * oneof key is named `result` or the individual variant. Be defensive.
 */
function extractSessionId(receipt: any): bigint | null {
  if (!receipt) return null
  if (receipt.err) {
    throw new Error(`01 CreateSession rejected: ${JSON.stringify(receipt.err)}`)
  }
  const candidates = [
    receipt.result?.createSession?.sessionId,
    receipt.result?.create_session?.sessionId,
    receipt.createSessionResult?.sessionId,
    receipt.createSession?.sessionId,
    receipt.sessionId,
  ]
  for (const c of candidates) {
    if (c === undefined || c === null) continue
    try {
      return BigInt(c)
    } catch {
      continue
    }
  }
  return null
}
