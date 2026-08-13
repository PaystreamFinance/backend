import type { Context } from 'grammy'
import { getAuthData } from '../middleware/auth.js'
import { getPortfolio } from '../../services/portfolio.js'

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export async function portfolioCommand(ctx: Context) {
  const auth = getAuthData(ctx)
  if (!auth) return

  const portfolio = await getPortfolio(auth.privyUserId)

  const lines: string[] = ['<b>Portfolio Summary</b>', '']

  // Wallets
  lines.push(`Solana: <code>${auth.walletAddress}</code>`)
  if (auth.ethAddress) {
    lines.push(`Ethereum: <code>${auth.ethAddress}</code>`)
  }
  lines.push('')

  if (portfolio.arbPositions.count === 0 && portfolio.spotPerpTrades.count === 0) {
    lines.push('No active positions.')
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
    return
  }

  if (portfolio.arbPositions.count > 0) {
    lines.push(`<b>Arb Positions (${portfolio.arbPositions.count})</b>`)
    lines.push(`Total Margin: $${portfolio.arbPositions.totalMarginUsd.toFixed(2)}`)
    lines.push('')

    for (const pos of portfolio.arbPositions.positions) {
      lines.push(
        `<b>${pos.symbol}</b> \u00B7 ${capitalize(pos.longProtocol)}/${capitalize(pos.shortProtocol)}` +
          ` \u00B7 $${pos.totalMarginUsd.toFixed(2)} \u00B7 ${pos.status}`,
      )
    }
    lines.push('')
  }

  if (portfolio.spotPerpTrades.count > 0) {
    lines.push(`<b>Spot-Perp Trades (${portfolio.spotPerpTrades.count})</b>`)
    lines.push(`Total: $${portfolio.spotPerpTrades.totalUsd.toFixed(2)}`)
    lines.push('')

    for (const pos of portfolio.spotPerpTrades.positions) {
      lines.push(
        `<b>${pos.market}</b> \u00B7 ${capitalize(pos.perpProtocol)}` +
          ` \u00B7 $${pos.totalUsd.toFixed(2)} \u00B7 ${pos.status}`,
      )
    }
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}
