import { privy, getAuthorizationContext } from '../privy'
import { db } from '@paystream/db'
import { exchangeApiKeys } from '@paystream/db/schema'
import { and, eq } from 'drizzle-orm'
import { log } from '../../utils/log'
import {
  generateAPIKey,
  createClient,
  checkClient,
  signChangePubKey,
  type LighterCredentials,
} from '@paystream/perps/lighter/signer'
import { createLighterClient } from '@paystream/perps/clients/lighter-client'

const LIGHTER_BASE_URL = 'https://mainnet.zklighter.elliot.ai'
const LIGHTER_CHAIN_ID = 304
const API_KEY_INDEX = 3

// In-memory cache (keyed by privyUserId)
const credentialCache = new Map<string, LighterCredentials>()

/**
 * Get or create Lighter API credentials for a user.
 *
 * Flow (ported from lighter-mvp, using Privy for EIP-191 signing):
 * 1. Check DB / in-memory cache for existing credentials
 * 2. Generate API key pair (FFI)
 * 3. Look up Lighter account by ETH L1 address
 * 4. Create signer client (FFI)
 * 5. Get nonce, sign ChangePubKey tx, sign with ETH key via Privy
 * 6. Submit ChangePubKey transaction
 * 7. Verify and persist
 */
export async function getOrCreateLighterApiCredentials(
  privyUserId: string,
  ethWalletAddress: string,
  ethWalletId: string,
  authContext: { authorization_private_keys: string[] },
): Promise<LighterCredentials> {
  // 1. Check in-memory cache
  const cached = credentialCache.get(privyUserId)
  if (cached) {
    // Re-initialize the FFI client with cached credentials
    try {
      await createClient(LIGHTER_BASE_URL, cached.apiPrivateKey, LIGHTER_CHAIN_ID, cached.apiKeyIndex, cached.accountIndex)
      log.info(`[lighter-auth] Using cached credentials for ${privyUserId}`)
      return cached
    } catch (e) {
      log.warn(`[lighter-auth] Cached credentials FFI init failed, re-checking DB:`, e)
      credentialCache.delete(privyUserId)
    }
  }

  // 2. Check DB
  const [dbRecord] = await db.select().from(exchangeApiKeys)
    .where(and(eq(exchangeApiKeys.privyUserId, privyUserId), eq(exchangeApiKeys.exchange, 'lighter')))
    .limit(1)

  if (dbRecord && dbRecord.isActive) {
    const creds = dbRecord.credentials as unknown as LighterCredentials
    try {
      await createClient(LIGHTER_BASE_URL, creds.apiPrivateKey, LIGHTER_CHAIN_ID, creds.apiKeyIndex, creds.accountIndex)
      credentialCache.set(privyUserId, creds)
      // Update lastUsedAt
      await db.update(exchangeApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(exchangeApiKeys.id, dbRecord.id))
        .catch(() => {})
      log.info(`[lighter-auth] Loaded credentials from DB for ${privyUserId}`)
      return creds
    } catch (e) {
      log.warn(`[lighter-auth] DB credentials FFI init failed, creating new:`, e)
    }
  }

  // 3. Full auth flow
  log.info(`[lighter-auth] Starting full auth flow for ${privyUserId} (ETH: ${ethWalletAddress})`)

  // 3a. Pre-check: verify account exists and has balance
  const lighterClient = createLighterClient()
  const account = await lighterClient.getAccountByL1Address(ethWalletAddress)
  if (!account) {
    throw new Error(
      `No Lighter account found for ETH address ${ethWalletAddress}. ` +
      `User needs to deposit funds at https://lighter.xyz first.`
    )
  }
  const accountIndex = account.account_index
  const accountBalance = parseFloat(account.balance || '0')
  log.info(`[lighter-auth] Found account index: ${accountIndex}, balance: ${accountBalance}`)

  if (accountBalance <= 0) {
    throw new Error(
      `Lighter account ${accountIndex} for ${ethWalletAddress} has zero balance. ` +
      `User needs to deposit funds at https://lighter.xyz first.`
    )
  }

  // 3b. Generate API key pair
  const apiKey = await generateAPIKey()
  log.info('[lighter-auth] Generated API key')

  // 3c. Create signer client (registers key in Go library)
  await createClient(LIGHTER_BASE_URL, apiKey.privateKey, LIGHTER_CHAIN_ID, API_KEY_INDEX, accountIndex)
  log.info(`[lighter-auth] Signer client created`)

  // 3d. Get nonce
  const nonce = await lighterClient.getNextNonce(accountIndex, API_KEY_INDEX)
  log.info(`[lighter-auth] Nonce: ${nonce}`)

  // 3e. Sign ChangePubKey transaction (FFI)
  const changePubKeyTx = await signChangePubKey(apiKey.publicKey, nonce, API_KEY_INDEX, accountIndex)
  log.info(`[lighter-auth] ChangePubKey tx type: ${changePubKeyTx.txType}`)

  if (!changePubKeyTx.messageToSign) {
    throw new Error('ChangePubKey did not return a message to sign')
  }

  // 3f. Sign with ETH wallet via Privy (EIP-191 personal_sign)
  const signResult = await privy.wallets().ethereum().signMessage(ethWalletId, {
    message: changePubKeyTx.messageToSign,
    authorization_context: authContext,
  })

  if (!signResult?.signature) {
    throw new Error('Failed to sign ChangePubKey message with Privy ETH wallet')
  }
  log.info(`[lighter-auth] L1 signature: ${signResult.signature.slice(0, 20)}...`)

  // 3g. Inject L1Sig into txInfo
  const txInfoObj = JSON.parse(changePubKeyTx.txInfo)
  txInfoObj.L1Sig = signResult.signature
  const finalTxInfo = JSON.stringify(txInfoObj)

  // 3h. Submit ChangePubKey transaction
  const txResult = await lighterClient.sendTx(changePubKeyTx.txType, finalTxInfo)
  log.info(`[lighter-auth] ChangePubKey tx result: ${JSON.stringify(txResult)}`)

  if (txResult.error) {
    throw new Error(`ChangePubKey transaction failed: ${txResult.error}`)
  }

  // 3i. Wait for propagation and verify
  log.info(`[lighter-auth] Waiting 2s for propagation...`)
  await new Promise(r => setTimeout(r, 2000))

  try {
    await checkClient(API_KEY_INDEX, accountIndex)
    log.info(`[lighter-auth] API key verified successfully`)
  } catch (e) {
    log.warn(`[lighter-auth] API key verification failed (may need more time):`, e)
  }

  // 3j. Build credentials object
  const credentials: LighterCredentials = {
    apiPrivateKey: apiKey.privateKey,
    apiPublicKey: apiKey.publicKey,
    apiKeyIndex: API_KEY_INDEX,
    accountIndex,
  }

  // 3k. Persist to DB
  await db.insert(exchangeApiKeys)
    .values({
      privyUserId,
      walletAddress: ethWalletAddress,
      exchange: 'lighter',
      credentials: credentials as any,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [exchangeApiKeys.privyUserId, exchangeApiKeys.exchange],
      set: {
        credentials: credentials as any,
        walletAddress: ethWalletAddress,
        isActive: true,
        updatedAt: new Date(),
      },
    })

  // 3l. Cache and return
  credentialCache.set(privyUserId, credentials)
  log.info(`[lighter-auth] Credentials created and persisted for ${privyUserId}`)

  return credentials
}

/**
 * Get stored credentials from cache (no DB lookup)
 */
export function getStoredLighterCredentials(privyUserId: string): LighterCredentials | null {
  return credentialCache.get(privyUserId) ?? null
}

/**
 * Get credentials from in-memory cache or DB (async).
 * Does NOT create new credentials if none exist.
 */
export async function getStoredLighterCredentialsAsync(privyUserId: string): Promise<LighterCredentials | null> {
  const cached = credentialCache.get(privyUserId)
  if (cached) return cached

  const [dbRecord] = await db.select().from(exchangeApiKeys)
    .where(and(eq(exchangeApiKeys.privyUserId, privyUserId), eq(exchangeApiKeys.exchange, 'lighter')))
    .limit(1)

  if (dbRecord && dbRecord.isActive) {
    const creds = dbRecord.credentials as unknown as LighterCredentials
    if (creds.apiPrivateKey && creds.accountIndex != null) {
      credentialCache.set(privyUserId, creds)
      return creds
    }
  }

  return null
}

/**
 * Wire ethAddress + (if available) stored credentials onto the Lighter
 * provider. Required for any read path that calls signed Lighter endpoints —
 * notably TP/SL trigger fetching via `accountActiveOrders`.
 */
export async function applyLighterReadCredentials(
  provider: { setEthAddress: (a: string) => void; setCredentials: (c: LighterCredentials) => Promise<void> },
  privyUserId: string,
  ethAddress: string,
): Promise<void> {
  provider.setEthAddress(ethAddress)
  const creds = await getStoredLighterCredentialsAsync(privyUserId)
  if (creds) await provider.setCredentials(creds)
}

/**
 * Invalidate cached credentials
 */
export function invalidateLighterCredentials(privyUserId: string): void {
  credentialCache.delete(privyUserId)
  db.update(exchangeApiKeys)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(exchangeApiKeys.privyUserId, privyUserId), eq(exchangeApiKeys.exchange, 'lighter')))
    .catch(e => log.error('[lighter-auth] Failed to invalidate DB credentials:', e))
  log.info(`[lighter-auth] Invalidated credentials for ${privyUserId}`)
}
