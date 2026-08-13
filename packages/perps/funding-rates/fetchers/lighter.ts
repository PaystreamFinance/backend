import type { FundingRateRecord } from '../types'
import { withRetry, floorToHour } from '../utils'
import { log } from '../../logger'

const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai/api/v1'

interface LighterFundingRate {
  market_id: number
  exchange: string
  symbol: string
  rate: number
}

interface LighterApiResponse {
  code: number
  funding_rates: LighterFundingRate[]
}

export async function fetchHistoricalRates(
  _since: Date | null,
  _symbols?: string[],
): Promise<FundingRateRecord[]> {
  const records: FundingRateRecord[] = []

  try {
    const data: LighterApiResponse = await withRetry(
      async () => {
        const res = await fetch(`${LIGHTER_API}/funding-rates`)
        if (!res.ok) throw new Error(`Lighter API ${res.status}: ${res.statusText}`)
        return res.json()
      },
      'Lighter funding-rates',
    )

    const rates = data.funding_rates
    if (!Array.isArray(rates)) {
      log.warn('[lighter] Unexpected API response structure')
      return records
    }

    const now = floorToHour(new Date())

    for (const item of rates) {
      // Only include Lighter-native rates, not cross-exchange references
      if (item.exchange !== 'lighter') continue

      const rate = typeof item.rate === 'number' ? item.rate : parseFloat(String(item.rate))
      if (isNaN(rate)) continue

      const symbol = (item.symbol || '')
        .toUpperCase()
        .replace(/-PERP$/, '')
        .replace(/-USD$/, '')

      if (!symbol) continue

      records.push({
        dex: 'lighter',
        symbol,
        protocolSymbol: item.symbol,
        timestamp: now,
        rate,
        granularity: '1h',
      })
    }

    log.info(`[lighter] ${records.length} current rates`)
  } catch (err) {
    log.error('[lighter] Fetch failed:', err)
  }

  return records
}
