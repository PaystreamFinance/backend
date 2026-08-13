import { db } from '@paystream/db'
import { arbPositionPairs } from '@paystream/db/schema'
import { eq, and, isNotNull } from 'drizzle-orm'
import { log } from '../utils/log'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'
import { notifyTelegram } from '../utils/telegram-notify'

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:9090'

let schedulerInterval: NodeJS.Timeout | null = null
let isRunning = false

// Suppress duplicate notifications: track last notified symbol per user.
// Only re-notify when the best opportunity symbol changes.
const lastNotified = new Map<string, string>()

interface MarketData {
  fundingRate: string | null
}

interface MarketResponse {
  symbol: string
  aster: MarketData | null
  lighter: MarketData | null
  pacifica: MarketData | null
  hyperliquid: MarketData | null
  '01': MarketData | null
  phoenix: MarketData | null
}

interface MarketsApiResponse {
  status: string
  markets: MarketResponse[]
}

interface MarketOpportunity {
  symbol: string
  apy: number
  longProtocol: string
  shortProtocol: string
}

function parseFundingRate(rateStr: string | null | undefined): number | null {
  if (!rateStr) return null
  const cleaned = rateStr.replace('%', '').trim()
  const parsed = parseFloat(cleaned)
  return isNaN(parsed) ? null : parsed
}

/**
 * Compute the best arb APY for a market by finding the optimal long/short pair.
 * Matches frontend logic: long = lowest rate, short = highest rate.
 * Aster/Lighter rates are per-interval (default 8h), so divide by 8.
 */
function computeMarketOpportunity(market: MarketResponse): MarketOpportunity | null {
  const rates: { protocol: string; rate: number }[] = []

  const pacificaRate = parseFundingRate(market.pacifica?.fundingRate)
  if (pacificaRate != null) rates.push({ protocol: 'pacifica', rate: pacificaRate })

  const hlRate = parseFundingRate(market.hyperliquid?.fundingRate)
  if (hlRate != null) rates.push({ protocol: 'hyperliquid', rate: hlRate })

  const asterRaw = parseFundingRate(market.aster?.fundingRate)
  if (asterRaw != null) rates.push({ protocol: 'aster', rate: asterRaw / 8 })

  const lighterRaw = parseFundingRate(market.lighter?.fundingRate)
  if (lighterRaw != null) rates.push({ protocol: 'lighter', rate: lighterRaw / 8 })

  const zoRate = parseFundingRate(market['01']?.fundingRate)
  if (zoRate != null) rates.push({ protocol: '01', rate: zoRate })

  const phoenixRate = parseFundingRate(market.phoenix?.fundingRate)
  if (phoenixRate != null) rates.push({ protocol: 'phoenix', rate: phoenixRate })

  if (rates.length < 2) return null

  rates.sort((a, b) => a.rate - b.rate)
  const long = rates[0]
  const short = rates[rates.length - 1]
  const spread = short.rate - long.rate
  const apy = spread * 24 * 365

  if (apy <= 0) return null

  return {
    symbol: market.symbol,
    apy,
    longProtocol: long.protocol,
    shortProtocol: short.protocol,
  }
}

async function checkBetterOpportunities(): Promise<void> {
  if (isRunning) return
  isRunning = true

  try {
    const response = await fetch(`${BACKEND_URL}/api/arb/markets`)
    if (!response.ok) {
      log.warn(`[opportunity-checker] Markets API returned ${response.status}`)
      return
    }

    const data = (await response.json()) as MarketsApiResponse
    if (data.status !== 'success' || !Array.isArray(data.markets)) {
      log.warn('[opportunity-checker] Invalid markets response')
      return
    }

    const opportunities: MarketOpportunity[] = []
    for (const market of data.markets) {
      const opp = computeMarketOpportunity(market)
      if (opp) opportunities.push(opp)
    }

    if (opportunities.length === 0) {
      log.info('[opportunity-checker] No arb opportunities found in current markets')
      return
    }

    opportunities.sort((a, b) => b.apy - a.apy)
    const bestOpportunity = opportunities[0]

    log.info(`[opportunity-checker] Best opportunity: ${bestOpportunity.symbol} at ${bestOpportunity.apy.toFixed(1)}% APY`)

    const activePositions = await db
      .select({
        privyUserId: arbPositionPairs.privyUserId,
        symbol: arbPositionPairs.symbol,
        entryApy: arbPositionPairs.entryApy,
      })
      .from(arbPositionPairs)
      .where(
        and(
          eq(arbPositionPairs.active, true),
          eq(arbPositionPairs.status, 'open'),
          isNotNull(arbPositionPairs.entryApy),
        ),
      )

    if (activePositions.length === 0) {
      log.info('[opportunity-checker] No active positions with entry APY to check')
      return
    }

    const userBest = new Map<string, { symbol: string; entryApy: number }>()
    for (const pos of activePositions) {
      const current = userBest.get(pos.privyUserId)
      if (!current || pos.entryApy! > current.entryApy) {
        userBest.set(pos.privyUserId, {
          symbol: pos.symbol,
          entryApy: pos.entryApy!,
        })
      }
    }

    let notified = 0
    for (const [privyUserId, userPosition] of userBest) {
      if (bestOpportunity.apy <= userPosition.entryApy) continue

      // Skip if user's best position is already on the best opportunity's symbol
      if (userPosition.symbol === bestOpportunity.symbol) continue

      // Suppress duplicate: don't re-notify about the same symbol
      if (lastNotified.get(privyUserId) === bestOpportunity.symbol) continue

      notifyTelegram(privyUserId, 'better_opportunity', {
        currentSymbol: userPosition.symbol,
        currentApy: userPosition.entryApy,
        betterSymbol: bestOpportunity.symbol,
        betterApy: bestOpportunity.apy,
        betterLongProtocol: bestOpportunity.longProtocol,
        betterShortProtocol: bestOpportunity.shortProtocol,
      })
      lastNotified.set(privyUserId, bestOpportunity.symbol)
      notified++
    }

    log.info(`[opportunity-checker] Checked ${userBest.size} users, notified ${notified}`)
  } catch (err) {
    log.error('[opportunity-checker] Error:', err)
    sendOpsAlert({
      key: 'opportunity-checker-error',
      severity: AlertSeverity.WARNING,
      title: 'Opportunity checker failed',
      message: err instanceof Error ? err.message : String(err),
      service: 'core-worker',
      error: err,
    })
  } finally {
    isRunning = false
  }
}

export function startOpportunityChecker(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (schedulerInterval) {
    log.info('[opportunity-checker] Already running')
    return
  }

  const intervalMinutes = (intervalMs / 1000 / 60).toFixed(0)
  log.info(`[opportunity-checker] Started (interval: ${intervalMinutes} minutes)`)
  checkBetterOpportunities()
  schedulerInterval = setInterval(checkBetterOpportunities, intervalMs)
}

export function stopOpportunityChecker(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
    log.info('[opportunity-checker] Stopped')
  }
}

export function getConfiguredInterval(): number {
  const env = process.env.OPPORTUNITY_CHECKER_INTERVAL_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_INTERVAL_MS
}
