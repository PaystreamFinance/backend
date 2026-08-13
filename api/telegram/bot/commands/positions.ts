import type { Context } from 'grammy'
import { getAuthData } from '../middleware/auth.js'
import {
  getDetailedPositions,
  fetchLivePositions,
  type LivePositionInfo,
  type LivePositionsByProtocol,
} from '../../services/portfolio.js'

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function findLivePosition(
  live: LivePositionsByProtocol,
  protocol: string,
  symbol: string,
  direction: string,
): LivePositionInfo | null {
  const protocolKey = protocol as keyof LivePositionsByProtocol
  const positions = live[protocolKey]
  if (!positions) return null

  return positions.find(
    (p) => p.symbol.toUpperCase() === symbol.toUpperCase() && p.direction === direction,
  ) ?? null
}

export async function positionsCommand(ctx: Context) {
  const auth = getAuthData(ctx)
  if (!auth) return

  const loadingMsg = await ctx.reply('\u{1F504} Fetching live positions...')
  const deleteLoading = () => ctx.api.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id).catch(() => {})

  // Fetch both DB pairs and live positions in parallel
  const [dbPositions, live] = await Promise.all([
    getDetailedPositions(auth.privyUserId),
    fetchLivePositions(auth.privyUserId, auth.walletAddress, auth.ethAddress),
  ])

  // If we have live data, show it — even if DB has nothing
  if (live) {
    const allLivePositions: Array<LivePositionInfo & { protocol: string }> = []
    for (const [protocol, positions] of Object.entries(live)) {
      for (const pos of positions) {
        allLivePositions.push({ ...pos, protocol })
      }
    }

    if (allLivePositions.length === 0 && dbPositions.length === 0) {
      await deleteLoading()
      await ctx.reply('No active positions found.')
      return
    }

    const lines: string[] = ['<b>Active Positions</b>', '<i>Live data from DEXes</i>', '']

    // First show DB-tracked arb pairs with live data enrichment
    if (dbPositions.length > 0) {
      for (const pos of dbPositions) {
        const liveLong = findLivePosition(live, pos.longProtocol, pos.symbol, 'long')
        const liveShort = findLivePosition(live, pos.shortProtocol, pos.symbol, 'short')

        lines.push(`<b>${pos.symbol}</b>`)
        lines.push(
          `\u{1F7E2} Long: ${capitalize(pos.longProtocol)} \u00B7 \u{1F534} Short: ${capitalize(pos.shortProtocol)}`,
        )

        const longEntry = liveLong?.entryPrice ?? pos.longEntryPrice
        const shortEntry = liveShort?.entryPrice ?? pos.shortEntryPrice
        lines.push(`Entry: $${longEntry?.toFixed(2) ?? 'N/A'} / $${shortEntry?.toFixed(2) ?? 'N/A'}`)

        const longLev = liveLong?.leverage ?? pos.longLeverage
        const shortLev = liveShort?.leverage ?? pos.shortLeverage
        lines.push(`Leverage: ${longLev}x / ${shortLev}x`)
        lines.push(`Margin: $${pos.totalMarginUsd.toFixed(2)}`)

        const longLiq = liveLong?.liquidationPrice ?? pos.longLiquidationPrice
        const shortLiq = liveShort?.liquidationPrice ?? pos.shortLiquidationPrice
        lines.push(`Liq: $${longLiq?.toFixed(2) ?? 'N/A'} / $${shortLiq?.toFixed(2) ?? 'N/A'}`)

        // PnL from live data
        if (liveLong || liveShort) {
          const longPnl = liveLong?.pnl ?? 0
          const shortPnl = liveShort?.pnl ?? 0
          const totalPnl = longPnl + shortPnl
          const pnlEmoji = totalPnl >= 0 ? '\u{1F4C8}' : '\u{1F4C9}'
          lines.push(
            `${pnlEmoji} PnL: <b>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>` +
              ` (\u{1F7E2} ${longPnl >= 0 ? '+' : ''}$${longPnl.toFixed(2)}` +
              ` / \u{1F534} ${shortPnl >= 0 ? '+' : ''}$${shortPnl.toFixed(2)})`,
          )

          const longFunding = liveLong?.fundingIncome ?? 0
          const shortFunding = liveShort?.fundingIncome ?? 0
          const totalFunding = longFunding + shortFunding
          if (totalFunding !== 0) {
            lines.push(`\u{1F4B0} Funding: ${totalFunding >= 0 ? '+' : ''}$${totalFunding.toFixed(2)}`)
          }
        }

        const size = liveLong?.sizeAsset ?? liveShort?.sizeAsset ?? pos.sizeAsset
        if (size) {
          lines.push(`Size: ${size.toFixed(6)} ${pos.symbol}`)
        }

        lines.push('')
      }
    }

    // Show any live positions NOT tracked in DB pairs
    // Build a set of protocol+symbol+direction that are already shown
    const shownKeys = new Set<string>()
    for (const pos of dbPositions) {
      shownKeys.add(`${pos.longProtocol}:${pos.symbol.toUpperCase()}:long`)
      shownKeys.add(`${pos.shortProtocol}:${pos.symbol.toUpperCase()}:short`)
    }

    const untrackedPositions = allLivePositions.filter(
      (p) => !shownKeys.has(`${p.protocol}:${p.symbol.toUpperCase()}:${p.direction}`),
    )

    if (untrackedPositions.length > 0) {
      if (dbPositions.length > 0) {
        lines.push('<b>Other DEX Positions</b>', '')
      }

      for (const pos of untrackedPositions) {
        const dirEmoji = pos.direction === 'long' ? '\u{1F7E2}' : '\u{1F534}'
        const pnlEmoji = pos.pnl >= 0 ? '\u{1F4C8}' : '\u{1F4C9}'

        lines.push(`<b>${pos.symbol}</b>`)
        lines.push(`${dirEmoji} ${capitalize(pos.direction)} on ${capitalize(pos.protocol)}`)
        lines.push(`Entry: $${pos.entryPrice.toFixed(2)} | Leverage: ${pos.leverage}x`)
        lines.push(`Margin: $${pos.margin.toFixed(2)} | Size: ${pos.sizeAsset.toFixed(6)} ${pos.symbol}`)
        if (pos.liquidationPrice) {
          lines.push(`Liq: $${pos.liquidationPrice.toFixed(2)}`)
        }
        lines.push(
          `${pnlEmoji} PnL: <b>${pos.pnl >= 0 ? '+' : ''}$${pos.pnl.toFixed(2)}</b>`,
        )
        if (pos.fundingIncome !== 0) {
          lines.push(`\u{1F4B0} Funding: ${pos.fundingIncome >= 0 ? '+' : ''}$${pos.fundingIncome.toFixed(2)}`)
        }
        lines.push('')
      }
    }

    await deleteLoading()
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
    return
  }

  // Live fetch failed — fall back to DB only
  if (dbPositions.length === 0) {
    await deleteLoading()
    await ctx.reply('No active positions found.')
    return
  }

  const lines: string[] = [
    `<b>Active Positions (${dbPositions.length})</b>`,
    '<i>Data from last worker check (live fetch unavailable)</i>',
    '',
  ]

  for (const pos of dbPositions) {
    lines.push(`<b>${pos.symbol}</b>`)
    lines.push(
      `\u{1F7E2} Long: ${capitalize(pos.longProtocol)} \u00B7 \u{1F534} Short: ${capitalize(pos.shortProtocol)}`,
    )
    lines.push(`Entry: $${pos.longEntryPrice?.toFixed(2) ?? 'N/A'} / $${pos.shortEntryPrice?.toFixed(2) ?? 'N/A'}`)
    lines.push(`Leverage: ${pos.longLeverage}x / ${pos.shortLeverage}x`)
    lines.push(`Margin: $${pos.totalMarginUsd.toFixed(2)}`)
    lines.push(`Liq: $${pos.longLiquidationPrice?.toFixed(2) ?? 'N/A'} / $${pos.shortLiquidationPrice?.toFixed(2) ?? 'N/A'}`)

    if (pos.lastOraclePrice && pos.sizeAsset) {
      let longPnl = 0
      let shortPnl = 0
      if (pos.longEntryPrice) longPnl = (pos.lastOraclePrice - pos.longEntryPrice) * pos.sizeAsset
      if (pos.shortEntryPrice) shortPnl = (pos.shortEntryPrice - pos.lastOraclePrice) * pos.sizeAsset
      const totalPnl = longPnl + shortPnl
      const pnlEmoji = totalPnl >= 0 ? '\u{1F4C8}' : '\u{1F4C9}'
      lines.push(`${pnlEmoji} PnL: <b>${totalPnl >= 0 ? '+' : ''}$${Math.abs(totalPnl).toFixed(2)}</b> <i>(est.)</i>`)
    }

    if (pos.sizeAsset) {
      lines.push(`Size: ${pos.sizeAsset.toFixed(6)} ${pos.symbol}`)
    }

    lines.push(`Pair #${pos.id}`, '')
  }

  const totalMargin = dbPositions.reduce((sum, p) => sum + p.totalMarginUsd, 0)
  lines.push(`<b>Total Margin: $${totalMargin.toFixed(2)}</b>`)

  await deleteLoading()
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}
