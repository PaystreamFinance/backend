import type { Context } from 'grammy'
import { getAuthData } from '../middleware/auth.js'
import { getFundingRates } from '../../services/portfolio.js'

export async function fundingCommand(ctx: Context) {
  const auth = getAuthData(ctx)
  if (!auth) return

  const args = (ctx.match as string | undefined)?.trim()
  const symbol = args || undefined

  const rates = await getFundingRates(symbol)

  if (rates.length === 0) {
    const msg = symbol
      ? `No funding rates found for ${symbol}.`
      : 'No funding rate data available.'
    await ctx.reply(msg)
    return
  }

  const lines: string[] = [
    symbol ? `<b>Funding Rates \u2014 ${symbol}</b>` : '<b>Current Funding Rates</b>',
    '',
  ]

  // Group by symbol
  const bySymbol = new Map<string, typeof rates>()
  for (const r of rates) {
    const existing = bySymbol.get(r.symbol) ?? []
    existing.push(r)
    bySymbol.set(r.symbol, existing)
  }

  for (const [sym, symRates] of bySymbol) {
    lines.push(`<b>${sym}</b>`)
    for (const r of symRates) {
      const rateStr = (r.rate * 100).toFixed(4)
      const sign = r.rate >= 0 ? '+' : ''
      lines.push(`  ${r.dex}: ${sign}${rateStr}%`)
    }
    lines.push('')
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}
