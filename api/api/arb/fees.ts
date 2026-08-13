import type { Context } from 'hono'
import { extractEmbeddedEthWallet, extractEmbeddedSolanaWallet } from '../../utils/wallet'
import { createHyperliquidClient } from '@paystream/perps/clients/hyperliquid-client'
import { createZoClient } from '@paystream/perps/clients/zo-client'
import { getMarketDataRegistry } from '@paystream/perps/registry'
import {
  PACIFICA_API_BASE,
  PACIFICA_HOST,
  getPacificaIPv4,
} from '@paystream/perps/providers/pacifica-provider'
import { log } from '../../utils/log'

// ==================== Fee Tier Tables ====================

const PACIFICA_FEE_TIERS = [
  { tier: 1, minVolume: 0, maxVolume: 5_000_000, takerBps: 4.0, makerBps: 1.5, label: 'Tier 1' },
  { tier: 2, minVolume: 5_000_000, maxVolume: 10_000_000, takerBps: 3.8, makerBps: 1.2, label: 'Tier 2' },
  { tier: 3, minVolume: 10_000_000, maxVolume: 25_000_000, takerBps: 3.6, makerBps: 0.9, label: 'Tier 3' },
  { tier: 4, minVolume: 25_000_000, maxVolume: 50_000_000, takerBps: 3.4, makerBps: 0.6, label: 'Tier 4' },
  { tier: 5, minVolume: 50_000_000, maxVolume: 100_000_000, takerBps: 3.2, makerBps: 0.3, label: 'Tier 5' },
  { tier: 6, minVolume: 100_000_000, maxVolume: 250_000_000, takerBps: 3.0, makerBps: 0, label: 'VIP 1' },
  { tier: 7, minVolume: 250_000_000, maxVolume: 500_000_000, takerBps: 2.9, makerBps: 0, label: 'VIP 2' },
  { tier: 8, minVolume: 500_000_000, maxVolume: null, takerBps: 2.8, makerBps: 0, label: 'VIP 3' },
]

const HYPERLIQUID_FEE_TIERS = [
  { tier: 0, minVolume: 0, maxVolume: 5_000_000, takerBps: 4.5, makerBps: 1.5, label: 'Tier 0' },
  { tier: 1, minVolume: 5_000_000, maxVolume: 25_000_000, takerBps: 4.0, makerBps: 1.2, label: 'Tier 1' },
  { tier: 2, minVolume: 25_000_000, maxVolume: 100_000_000, takerBps: 3.5, makerBps: 0.8, label: 'Tier 2' },
  { tier: 3, minVolume: 100_000_000, maxVolume: 500_000_000, takerBps: 3.0, makerBps: 0.4, label: 'Tier 3' },
  { tier: 4, minVolume: 500_000_000, maxVolume: 2_000_000_000, takerBps: 2.8, makerBps: 0, label: 'Tier 4' },
  { tier: 5, minVolume: 2_000_000_000, maxVolume: 7_000_000_000, takerBps: 2.6, makerBps: 0, label: 'Tier 5' },
  { tier: 6, minVolume: 7_000_000_000, maxVolume: null, takerBps: 2.4, makerBps: 0, label: 'Tier 6' },
]

const ASTER_FEE_TIERS = [
  { tier: 0, minVolume: 0, maxVolume: null, takerBps: 4.0, makerBps: 0.5, label: 'Base' },
]

const LIGHTER_FEE_TIERS = [
  { tier: 0, minVolume: 0, maxVolume: null, takerBps: 0, makerBps: 0, label: 'Standard' },
  { tier: 1, minVolume: 0, maxVolume: null, takerBps: 2.0, makerBps: 0.2, label: 'Premium' },
]

/** 01 doesn't publish volume breakpoints — brackets are rebuilt from the live `/fee/brackets/info` fetch. */
const ZO_FEE_TIERS_FALLBACK = [
  { tier: 0, minVolume: 0, maxVolume: null, takerBps: 3.5, makerBps: 1.0, label: 'Tier 0' },
]

// ==================== Types ====================

interface DexFeeInfo {
  dex: string
  takerFeeBps: number
  makerFeeBps: number
  tierLabel: string
  feeLevel?: number
  volumePeriod: string
  fundingInterval: string
  source: 'api' | 'on-chain' | 'hardcoded'
  feeTiers: typeof PACIFICA_FEE_TIERS
}

interface FeesSuccessResponse {
  status: 'success'
  message: string
  data: {
    fees: DexFeeInfo[]
  }
}

interface FeesErrorResponse {
  status: 'error'
  message: string
  error: string
}

// ==================== Per-DEX Fee Fetchers ====================

async function getPacificaFees(solanaAddress: string | null): Promise<DexFeeInfo> {
  if (solanaAddress) {
    try {
      let apiUrl = `${PACIFICA_API_BASE}/api/v1/account?account=${solanaAddress}`
      const headers: Record<string, string> = {}

      const ipv4 = getPacificaIPv4()
      if (ipv4) {
        apiUrl = apiUrl.replace(PACIFICA_HOST, ipv4)
        headers['Host'] = PACIFICA_HOST
      }

      const response = await fetch(apiUrl, { headers })
      if (response.ok) {
        const result = await response.json() as any
        if (result.success && result.data) {
          const feeLevel = result.data.fee_level ?? 0
          const makerFee = parseFloat(result.data.maker_fee || '0')
          const takerFee = parseFloat(result.data.taker_fee || '0')

          // Convert from decimal (e.g. 0.0004) to bps (4.0)
          const takerBps = takerFee * 10000
          const makerBps = makerFee * 10000

          const tier = PACIFICA_FEE_TIERS.find(t => t.tier === feeLevel + 1) || PACIFICA_FEE_TIERS[0]

          return {
            dex: 'pacifica',
            takerFeeBps: takerBps,
            makerFeeBps: makerBps,
            tierLabel: tier.label,
            feeLevel,
            volumePeriod: '14d rolling',
            fundingInterval: '1 hour',
            source: 'api',
            feeTiers: PACIFICA_FEE_TIERS,
          }
        }
      }
    } catch (error) {
      log.warn('[arb/fees] Failed to fetch Pacifica user fees:', error)
    }
  }

  return {
    dex: 'pacifica',
    takerFeeBps: 4.0,
    makerFeeBps: 1.5,
    tierLabel: 'Tier 1',
    volumePeriod: '14d rolling',
    fundingInterval: '1 hour',
    source: 'hardcoded',
    feeTiers: PACIFICA_FEE_TIERS,
  }
}

async function getHyperliquidFees(ethAddress: string | null): Promise<DexFeeInfo> {
  if (ethAddress) {
    try {
      const client = createHyperliquidClient(ethAddress, false)
      const userFees = await client.getUserFees(ethAddress)

      if (userFees) {
        const takerRate = parseFloat(userFees.userCrossRate || '0')
        const makerRate = parseFloat(userFees.userAddRate || '0')
        const takerBps = takerRate * 10000
        const makerBps = makerRate * 10000

        const tierLabel = userFees.feeSchedule?.name || 'Tier 0'

        return {
          dex: 'hyperliquid',
          takerFeeBps: takerBps,
          makerFeeBps: makerBps,
          tierLabel,
          volumePeriod: '14d weighted',
          fundingInterval: '8 hours',
          source: 'api',
          feeTiers: HYPERLIQUID_FEE_TIERS,
        }
      }
    } catch (error) {
      log.warn('[arb/fees] Failed to fetch Hyperliquid user fees:', error)
    }
  }

  return {
    dex: 'hyperliquid',
    takerFeeBps: 4.5,
    makerFeeBps: 1.5,
    tierLabel: 'Tier 0',
    volumePeriod: '14d weighted',
    fundingInterval: '8 hours',
    source: 'hardcoded',
    feeTiers: HYPERLIQUID_FEE_TIERS,
  }
}

async function getAsterFees(): Promise<DexFeeInfo> {
  // Aster has no API for user fee tiers
  return {
    dex: 'aster',
    takerFeeBps: 4.0,
    makerFeeBps: 0.5,
    tierLabel: 'Base',
    volumePeriod: '14d rolling',
    fundingInterval: '8 hours',
    source: 'hardcoded',
    feeTiers: ASTER_FEE_TIERS,
  }
}

async function getLighterFees(): Promise<DexFeeInfo> {
  try {
    const registry = await getMarketDataRegistry()
    const lighterProvider = registry.getProvider('lighter')
    if (lighterProvider) {
      const fees = await lighterProvider.getFees('ETH')
      return {
        dex: 'lighter',
        takerFeeBps: fees.takerFeeBps ?? 0,
        makerFeeBps: fees.makerFeeBps ?? 0,
        tierLabel: 'Standard',
        volumePeriod: 'N/A',
        fundingInterval: '1 hour',
        source: 'api',
        feeTiers: LIGHTER_FEE_TIERS,
      }
    }
  } catch (error) {
    log.warn('[arb/fees] Failed to fetch Lighter fees from provider:', error)
  }

  return {
    dex: 'lighter',
    takerFeeBps: 0,
    makerFeeBps: 0,
    tierLabel: 'Standard',
    volumePeriod: 'N/A',
    fundingInterval: '1 hour',
    source: 'hardcoded',
    feeTiers: LIGHTER_FEE_TIERS,
  }
}

async function getZoFees(solanaAddress: string | null): Promise<DexFeeInfo> {
  const client = createZoClient()

  const [bracketsResult, userResult] = await Promise.allSettled([
    client.getFeeBrackets(),
    solanaAddress ? client.getUserInfo(solanaAddress) : Promise.resolve(null),
  ])

  const brackets = bracketsResult.status === 'fulfilled' ? bracketsResult.value : []
  if (bracketsResult.status === 'rejected') {
    log.warn('[arb/fees] Failed to fetch 01 fee brackets:', bracketsResult.reason)
  }

  const feeTiers = brackets.length > 0
    ? brackets.map(([tierId, cfg]) => ({
        tier: tierId,
        minVolume: 0,
        maxVolume: null as number | null,
        takerBps: cfg.taker_fee_ppm / 100,
        makerBps: cfg.maker_fee_ppm / 100,
        label: `Tier ${tierId}`,
      }))
    : ZO_FEE_TIERS_FALLBACK

  const accountId = userResult.status === 'fulfilled' ? userResult.value?.accountIds?.[0] : undefined
  if (accountId !== undefined) {
    try {
      const tierId = await client.getAccountFeeTier(accountId)
      const match = tierId !== null ? feeTiers.find(t => t.tier === tierId) : null
      if (match) {
        return {
          dex: '01',
          takerFeeBps: match.takerBps,
          makerFeeBps: match.makerBps,
          tierLabel: match.label,
          feeLevel: match.tier,
          volumePeriod: 'N/A',
          fundingInterval: '1 hour',
          source: 'api',
          feeTiers,
        }
      }
    } catch (error) {
      log.warn('[arb/fees] Failed to fetch 01 user fee tier:', error)
    }
  }

  const defaultTier = feeTiers[0]
  return {
    dex: '01',
    takerFeeBps: defaultTier.takerBps,
    makerFeeBps: defaultTier.makerBps,
    tierLabel: defaultTier.label,
    volumePeriod: 'N/A',
    fundingInterval: '1 hour',
    source: brackets.length > 0 ? 'api' : 'hardcoded',
    feeTiers,
  }
}

// ==================== Handler ====================

/**
 * GET /api/arb/fees
 * Get fee structure for the authenticated user across all DEXes.
 * Returns maker/taker fees per DEX based on user's tier, plus fee tier tables.
 */
export async function feesHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      return c.json<FeesErrorResponse>({
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }, 401)
    }

    // Extract wallet addresses for user-specific fee lookups
    const linkedAccounts = authData.user.linked_accounts || []
    const solWallet = extractEmbeddedSolanaWallet(linkedAccounts)
    const ethWallet = extractEmbeddedEthWallet(linkedAccounts)

    const solanaAddress = solWallet?.address || null
    const ethAddress = ethWallet?.address || null

    log.info(`[arb/fees] Fetching fees for user ${authData.user.id}`)

    // Fetch fees from all DEXes in parallel
    const [pacifica, hyperliquid, aster, lighter, zo] = await Promise.all([
      getPacificaFees(solanaAddress),
      getHyperliquidFees(ethAddress),
      getAsterFees(),
      getLighterFees(),
      getZoFees(solanaAddress),
    ])

    return c.json<FeesSuccessResponse>({
      status: 'success',
      message: 'Fees retrieved successfully',
      data: {
        fees: [pacifica, hyperliquid, aster, lighter, zo],
      },
    })
  } catch (error) {
    log.error('[arb/fees] Error:', error instanceof Error ? error.message : error)
    return c.json<FeesErrorResponse>({
      status: 'error',
      message: 'Failed to get fee data',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  }
}
