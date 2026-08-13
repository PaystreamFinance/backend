import { PublicKey } from '@solana/web3.js'
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher'
import { JITO_ENDPOINTS, JITO_AUTH_KEYPAIR } from './constants'
import { log } from './log'

let cachedTipAccounts: PublicKey[] | null = null

export async function initializeTipAccounts(): Promise<void> {
  try {
    log.info('Initializing tip accounts cache...')
    // Use the default endpoint (Singapore) to get tip accounts
    const client = JITO_AUTH_KEYPAIR
      ? searcherClient(JITO_ENDPOINTS[0], JITO_AUTH_KEYPAIR)
      : searcherClient(JITO_ENDPOINTS[0])
    const tipAccountResult = await client.getTipAccounts()

    if (!tipAccountResult.ok) {
      log.error('❌ Failed to get tip accounts on startup:', tipAccountResult)
      throw new Error('Failed to initialize tip accounts')
    }

    cachedTipAccounts = tipAccountResult.value.map(
      (addr: string) => new PublicKey(addr)
    )
    log.info(`✅ Cached ${cachedTipAccounts.length} tip accounts`)
  } catch (error) {
    log.error('Failed to initialize tip accounts:', error)
    throw error
  }
}

export function getTipAccount(): PublicKey {
  if (!cachedTipAccounts || cachedTipAccounts.length === 0) {
    throw new Error('Tip accounts not initialized. Call initializeTipAccounts() first.')
  }
  // Return a random tip account from the cached list
  return cachedTipAccounts[
    Math.floor(Math.random() * cachedTipAccounts.length)
  ]!
}

export function getTipAccounts(): PublicKey[] {
  if (!cachedTipAccounts || cachedTipAccounts.length === 0) {
    throw new Error('Tip accounts not initialized. Call initializeTipAccounts() first.')
  }
  return cachedTipAccounts
}

