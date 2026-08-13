import { PublicKey } from '@solana/web3.js'
import type { Context } from 'hono'
import type {
  ArbFundingHistorySuccessResponse,
  ArbFundingHistoryErrorResponse,
  ArbProtocol,
  ArbBaseProtocol,
} from '../../../models/arb'
import { getInitializedProviders } from '@paystream/perps/registry'
import type { FundingPayment, FundingPaymentsResult } from '@paystream/perps/types'
import { getHip3ProtocolId, type Hip3ProtocolId } from '@paystream/perps/hip3/dex-config'
import { getStoredApiCredentialsAsync } from '../../../clients/arb/aster-auth'
import { getStoredLighterCredentialsAsync } from '../../../clients/arb/lighter-auth'
import { createClient as createLighterSignerClient, createAuthToken as createLighterAuthToken } from '@paystream/perps/lighter/signer'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../../utils/wallet'
import { log } from '../../../utils/log'

const LIGHTER_BASE_URL = 'https://mainnet.zklighter.elliot.ai'
const LIGHTER_CHAIN_ID = 304

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

/**
 * GET /api/arb/activity/funding/history
 * Fetch historical funding payments from all DEXes for the authenticated user.
 */
export async function fundingHistoryHandler(c: Context) {
  let registry = null

  try {
    const authData = c.privyUser

    if (!authData) {
      const response: ArbFundingHistoryErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const embeddedWallet = extractEmbeddedSolanaWallet(
      authData.user.linked_accounts || []
    )

    if (!embeddedWallet) {
      const response: ArbFundingHistoryErrorResponse = {
        status: 'error',
        message: 'No embedded Solana wallet found',
        error: 'Wallet not found',
      }
      return c.json(response, 400)
    }

    const embeddedEthWallet = extractEmbeddedEthWallet(
      authData.user.linked_accounts || []
    )

    // Default startTime to 1 year ago
    const startTimeParam = c.req.query('startTime')
    const endTimeParam = c.req.query('endTime')
    const startTime = startTimeParam ? Number(startTimeParam) : Date.now() - ONE_YEAR_MS
    const endTime = endTimeParam ? Number(endTimeParam) : undefined

    const walletPubkey = new PublicKey(embeddedWallet.address)
    registry = await getInitializedProviders(walletPubkey, embeddedEthWallet?.address)

    const hyperliquidProvider = registry.getHyperliquidProvider()
    const pacificaProvider = registry.getPacificaProvider()
    const asterProvider = registry.getAsterProvider()
    const lighterProvider = registry.getLighterProvider()
    const zoProvider = registry.getZoProvider()
    const phoenixProvider = registry.getPhoenixProvider()

    if (asterProvider) {
      const creds = await getStoredApiCredentialsAsync(authData.user.id)
      if (creds) {
        asterProvider.setApiCredentials(creds.apiKey, creds.apiSecret)
      }
    }

    const emptyResult: FundingPaymentsResult = { payments: [], truncated: false }

    const hip3Entries = embeddedEthWallet ? Array.from(registry.getHip3Providers().entries()) : []

    const [hlResult, pacificaResult, asterResult, lighterResult, zoResult, phoenixResult, ...hip3Results] = await Promise.allSettled([
      hyperliquidProvider?.getFundingPayments(startTime, endTime) ?? Promise.resolve(emptyResult),
      pacificaProvider?.getFundingPayments(startTime, endTime) ?? Promise.resolve(emptyResult),
      asterProvider?.getFundingPayments(startTime, endTime) ?? Promise.resolve(emptyResult),
      (async (): Promise<FundingPaymentsResult> => {
        if (!lighterProvider || !embeddedEthWallet) return emptyResult
        lighterProvider.setEthAddress(embeddedEthWallet.address)
        const lighterCreds = await getStoredLighterCredentialsAsync(authData.user.id)
        if (!lighterCreds) return emptyResult
        await createLighterSignerClient(LIGHTER_BASE_URL, lighterCreds.apiPrivateKey, LIGHTER_CHAIN_ID, lighterCreds.apiKeyIndex, lighterCreds.accountIndex)
        const deadline = Math.floor(Date.now() / 1000) + 600
        const authToken = await createLighterAuthToken(deadline, lighterCreds.apiKeyIndex, lighterCreds.accountIndex)
        return lighterProvider.getFundingPayments(startTime, endTime, authToken)
      })(),
      zoProvider?.getFundingPayments(startTime, endTime) ?? Promise.resolve(emptyResult),
      phoenixProvider?.getFundingPayments(startTime, endTime) ?? Promise.resolve(emptyResult),
      ...hip3Entries.map(([, provider]) => provider.getFundingPayments(startTime, endTime)),
    ])

    const results: Partial<Record<ArbProtocol, FundingPayment[]>> & Record<ArbBaseProtocol, FundingPayment[]> = {
      hyperliquid: [],
      pacifica: [],
      aster: [],
      lighter: [],
      '01': [],
      phoenix: [],
    }
    const errors: Partial<Record<ArbProtocol, string>> = {}
    const warnings: Partial<Record<ArbProtocol, string>> = {}

    const settled = [
      { key: 'hyperliquid' as const, result: hlResult },
      { key: 'pacifica' as const, result: pacificaResult },
      { key: 'aster' as const, result: asterResult },
      { key: 'lighter' as const, result: lighterResult },
      { key: '01' as const, result: zoResult },
      { key: 'phoenix' as const, result: phoenixResult },
    ]

    for (const { key, result } of settled) {
      if (result.status === 'fulfilled') {
        results[key] = result.value.payments
        if (result.value.truncated) {
          warnings[key] = `Results truncated — more funding history exists than could be retrieved`
        }
      } else {
        const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason)
        errors[key] = errMsg
        log.warn(`[funding-history] ${key} failed: ${errMsg}`)
      }
    }

    const hip3: Partial<Record<Hip3ProtocolId, FundingPayment[]>> = {}
    hip3Entries.forEach(([dexName], i) => {
      const protoId = getHip3ProtocolId(dexName)
      const result = hip3Results[i]
      if (result.status === 'fulfilled') {
        hip3[protoId] = result.value.payments
        if (result.value.truncated) {
          warnings[protoId] = `Results truncated — more funding history exists than could be retrieved`
        }
      } else {
        const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason)
        errors[protoId] = errMsg
        log.warn(`[funding-history] ${protoId} failed: ${errMsg}`)
      }
    })

    let fundingEarned = 0
    let fundingPaid = 0
    const allPayments: FundingPayment[][] = [...Object.values(results), ...Object.values(hip3)]
    for (const payments of allPayments) {
      if (!payments) continue
      for (const p of payments) {
        if (p.amount >= 0) fundingEarned += p.amount
        else fundingPaid += p.amount
      }
    }

    await registry.cleanup()

    const response: ArbFundingHistorySuccessResponse = {
      status: 'success',
      hyperliquid: results.hyperliquid,
      pacifica: results.pacifica,
      aster: results.aster,
      lighter: results.lighter,
      '01': results['01'],
      phoenix: results.phoenix,
      hip3,
      errors,
      warnings,
      fundingEarned: parseFloat(fundingEarned.toFixed(6)),
      fundingPaid: parseFloat(fundingPaid.toFixed(6)),
      totalFundingUsd: parseFloat((fundingEarned + fundingPaid).toFixed(6)),
    }

    return c.json(response)
  } catch (error) {
    log.error('[funding-history] Error:', error instanceof Error ? error.message : error)

    if (registry) {
      try {
        await registry.cleanup()
      } catch (cleanupError) {
        log.error('[funding-history] Error cleaning up:', cleanupError)
      }
    }

    const errorResponse: ArbFundingHistoryErrorResponse = {
      status: 'error',
      message: 'Failed to fetch funding history',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    return c.json(errorResponse, 500)
  }
}
