import { signMessageWithPrivy } from '../privy'
import { db } from '@paystream/db'
import { exchangeApiKeys } from '@paystream/db/schema'
import { and, eq } from 'drizzle-orm'
import { log } from '../../utils/log'

const ASTER_PUBLIC_URL = 'https://www.asterdex.com/bapi/futures/v1/public/future'

// In-memory credential store (keyed by privyUserId)
const credentialStore = new Map<string, { apiKey: string; apiSecret: string }>()

/**
 * Get cached API credentials, or run full auth flow to create new ones.
 *
 * Flow (uses embedded Solana wallet for Ed25519 signing):
 * 1. Check in-memory cache → DB
 * 2. POST get-nonce (type: LOGIN, network: SOL) → nonce
 * 3. Sign "You are signing into Astherus <nonce>" via Privy Solana wallet (base58 sig)
 * 4. POST ae/login (network: SOL, agentCode: 248Dbf) → session cookies
 * 5. POST get-nonce (type: CREATE_API_KEY, with cookies) → nonce
 * 6. Sign again with new nonce
 * 7. POST broker-create-api-key (with cookies, network: SOL) → { apiKey, apiSecret }
 * 8. Persist to DB + cache
 */
export async function getOrCreateAsterApiCredentials(
  privyUserId: string,
  solanaWalletAddress: string,
  solanaWalletId: string,
  authContext: { authorization_private_keys: string[] }
): Promise<{ apiKey: string; apiSecret: string }> {
  // 1. Check in-memory cache
  const cached = getStoredApiCredentials(privyUserId)
  if (cached) return cached

  // 2. Check DB
  const [dbRecord] = await db.select().from(exchangeApiKeys)
    .where(and(eq(exchangeApiKeys.privyUserId, privyUserId), eq(exchangeApiKeys.exchange, 'aster')))
    .limit(1)

  if (dbRecord && dbRecord.isActive) {
    const creds = dbRecord.credentials as unknown as { apiKey: string; apiSecret: string }
    if (creds.apiKey && creds.apiSecret) {
      credentialStore.set(privyUserId, creds)
      await db.update(exchangeApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(exchangeApiKeys.id, dbRecord.id))
        .catch(() => {})
      log.info(`[aster-auth] Loaded credentials from DB for ${privyUserId}`)
      return creds
    }
  }

  log.info(`[aster-auth] No cached credentials for ${privyUserId}, starting Solana auth flow (wallet: ${solanaWalletAddress})`)

  // 3. Get LOGIN nonce
  const loginNonce = await getAsterNonce(solanaWalletAddress, 'LOGIN')

  // 4. Sign nonce with Solana wallet (Ed25519, returns base58)
  const loginSig = await signAsterNonceSolana(solanaWalletId, loginNonce, authContext)

  // 5. Login with Solana network
  const loginResult = await loginToAster(loginSig, solanaWalletAddress)
  log.info(`[aster-auth] Logged in via Solana`)

  // 6. Get CREATE_API_KEY nonce (with session cookies)
  const apiKeyNonce = await getAsterNonceWithSession(solanaWalletAddress, 'CREATE_API_KEY', loginResult.sessionToken)

  // 7. Sign again with new nonce
  const apiKeySig = await signAsterNonceSolana(solanaWalletId, apiKeyNonce, authContext)

  // 8. Create API key
  const { apiKey, apiSecret } = await createAsterApiKey(apiKeySig, solanaWalletAddress, loginResult.sessionToken)
  log.info(`[aster-auth] Created API key: ${apiKey.slice(0, 8)}...`)

  // 9. Persist to DB
  await db.insert(exchangeApiKeys)
    .values({
      privyUserId,
      walletAddress: solanaWalletAddress,
      exchange: 'aster',
      credentials: { apiKey, apiSecret },
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [exchangeApiKeys.privyUserId, exchangeApiKeys.exchange],
      set: {
        credentials: { apiKey, apiSecret },
        walletAddress: solanaWalletAddress,
        isActive: true,
        updatedAt: new Date(),
      },
    })

  // 10. Cache
  credentialStore.set(privyUserId, { apiKey, apiSecret })

  return { apiKey, apiSecret }
}

export function getStoredApiCredentials(
  privyUserId: string
): { apiKey: string; apiSecret: string } | null {
  return credentialStore.get(privyUserId) ?? null
}

/**
 * Get API credentials from in-memory cache or DB (async).
 * Does NOT create new credentials if none exist.
 */
export async function getStoredApiCredentialsAsync(
  privyUserId: string
): Promise<{ apiKey: string; apiSecret: string } | null> {
  // 1. Check in-memory cache
  const cached = credentialStore.get(privyUserId)
  if (cached) return cached

  // 2. Check DB
  const [dbRecord] = await db.select().from(exchangeApiKeys)
    .where(and(eq(exchangeApiKeys.privyUserId, privyUserId), eq(exchangeApiKeys.exchange, 'aster')))
    .limit(1)

  if (dbRecord && dbRecord.isActive) {
    const creds = dbRecord.credentials as unknown as { apiKey: string; apiSecret: string }
    if (creds.apiKey && creds.apiSecret) {
      credentialStore.set(privyUserId, creds)
      return creds
    }
  }

  return null
}

export function invalidateApiCredentials(privyUserId: string): void {
  credentialStore.delete(privyUserId)
  db.update(exchangeApiKeys)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(exchangeApiKeys.privyUserId, privyUserId), eq(exchangeApiKeys.exchange, 'aster')))
    .catch(e => log.error('[aster-auth] Failed to invalidate DB credentials:', e))
  log.info(`[aster-auth] Invalidated credentials for ${privyUserId}`)
}

// ==================== Auth flow steps ====================

async function getAsterNonce(sourceAddr: string, type: 'LOGIN' | 'CREATE_API_KEY'): Promise<string> {
  const response = await fetch(`${ASTER_PUBLIC_URL}/web3/get-nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceAddr,
      type,
      network: 'SOL',
    }),
  })

  const text = await response.text()
  if (!response.ok) throw new Error(`Aster get-nonce failed ${response.status}: ${text}`)

  let data: any
  try { data = JSON.parse(text) } catch {
    throw new Error(`Aster get-nonce: invalid JSON: ${text.slice(0, 200)}`)
  }
  if (!data.data?.nonce) throw new Error(`Aster get-nonce: no nonce: ${text}`)

  return data.data.nonce
}

async function getAsterNonceWithSession(sourceAddr: string, type: 'LOGIN' | 'CREATE_API_KEY', sessionToken: string): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (sessionToken) headers['Cookie'] = sessionToken

  const response = await fetch(`${ASTER_PUBLIC_URL}/web3/get-nonce`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sourceAddr,
      type,
      network: 'SOL',
    }),
  })

  const text = await response.text()
  if (!response.ok) throw new Error(`Aster get-nonce (session) failed ${response.status}: ${text}`)

  let data: any
  try { data = JSON.parse(text) } catch {
    throw new Error(`Aster get-nonce (session): invalid JSON: ${text.slice(0, 200)}`)
  }
  if (!data.data?.nonce) throw new Error(`Aster get-nonce (session): no nonce: ${text}`)

  return data.data.nonce
}

/**
 * Sign "You are signing into Astherus <nonce>" with Solana Ed25519 via Privy
 * Returns base58-encoded signature
 */
async function signAsterNonceSolana(
  solanaWalletId: string,
  nonce: string,
  authContext: { authorization_private_keys: string[] }
): Promise<string> {
  const message = `You are signing into Astherus ${nonce}`
  const signature = await signMessageWithPrivy(solanaWalletId, message, authContext)
  log.info(`[aster-auth] Solana Ed25519 signature: ${signature.slice(0, 20)}...`)
  return signature
}

/**
 * Login to Aster with Solana network — returns session cookies
 */
async function loginToAster(signature: string, sourceAddr: string): Promise<{ data: any; sessionToken: string }> {
  const response = await fetch(`${ASTER_PUBLIC_URL}/web3/ae/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'clientType': 'broker',
    },
    body: JSON.stringify({
      signature,
      sourceAddr,
      network: 'SOL',
      agentCode: '248Dbf',
    }),
  })

  const setCookieHeaders = response.headers.getSetCookie?.() ?? []
  const allCookies = setCookieHeaders.map(c => c.split(';')[0]).join('; ')
  log.info(`[aster-auth] Login set-cookie: ${allCookies.slice(0, 200)}`)

  const text = await response.text()
  log.info(`[aster-auth] Login response: ${text.slice(0, 500)}`)

  if (!response.ok) throw new Error(`Aster login failed ${response.status}: ${text}`)

  let data: any
  try { data = JSON.parse(text) } catch {
    throw new Error(`Aster login: invalid JSON: ${text.slice(0, 200)}`)
  }

  if (!data.success) throw new Error(`Aster login error: ${JSON.stringify(data)}`)

  const sessionToken = allCookies || data.data?.token || ''
  if (!sessionToken) {
    log.warn(`[aster-auth] No session token found in login response — create-api-key may fail`)
  }

  return { data, sessionToken }
}

/**
 * Create API key on Aster using broker endpoint (requires session from login)
 * Uses Solana network parameter
 */
async function createAsterApiKey(
  signature: string,
  sourceAddr: string,
  sessionToken: string,
): Promise<{ apiKey: string; apiSecret: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'clientType': 'broker',
  }

  if (sessionToken) {
    headers['Cookie'] = sessionToken
  }

  const response = await fetch(`${ASTER_PUBLIC_URL}/web3/broker-create-api-key`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sourceAddr,
      signature,
      type: 'CREATE_API_KEY',
      desc: 'paystream-api',
      ip: '',
      sourceCode: 'ae',
      network: 'SOL',
    }),
  })

  const text = await response.text()
  log.info(`[aster-auth] Create API key response: ${text.slice(0, 500)}`)

  if (!response.ok) throw new Error(`Aster create-api-key failed ${response.status}: ${text}`)

  let data: any
  try { data = JSON.parse(text) } catch {
    throw new Error(`Aster create-api-key: invalid JSON: ${text.slice(0, 200)}`)
  }
  if (!data.data?.apiKey || !data.data?.apiSecret) {
    throw new Error(`Aster create-api-key: missing apiKey/apiSecret: ${text}`)
  }

  return { apiKey: data.data.apiKey, apiSecret: data.data.apiSecret }
}
