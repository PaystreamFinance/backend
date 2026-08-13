import type { Context } from 'hono'
import {
  extractEmbeddedEthWallet,
  extractEmbeddedSolanaWallet,
} from '../../../utils/wallet'
import { createHyperliquidClient } from '@paystream/perps/clients/hyperliquid-client'
import { createAsterClient } from '@paystream/perps/clients/aster-client'
import { createLighterClient } from '@paystream/perps/clients/lighter-client'
import { createZoClient } from '@paystream/perps/clients/zo-client'
import { createPhoenixArbProvider } from '@paystream/perps/providers/phoenix-provider'
import {
  PACIFICA_API_BASE,
  PACIFICA_HOST,
  getPacificaIPv4,
} from '@paystream/perps/providers/pacifica-provider'
import {
  HIP3_DEX_NAMES,
  getHip3Collateral,
  getHip3ProtocolId,
  type Hip3Collateral,
  type Hip3DexName,
  type Hip3ProtocolId,
} from '@paystream/perps/hip3/dex-config'
import { getOrCreateAsterApiCredentials } from '../../../clients/arb/aster-auth'
import { getAuthorizationContext } from '../../../clients/privy'
import { getZoInfoCache } from '../../../clients/arb/zo-info-cache'
import { log } from '../../../utils/log'

type DexId = 'hyperliquid' | 'aster' | 'lighter' | '01' | 'pacifica' | 'phoenix' | Hip3ProtocolId

const NUMERIC_FIELDS = [
  'accountValue',
  'accountEquity',
  'availableToTrade',
  'withdrawable',
  'totalMarginUsed',
  'totalPositionValue',
] as const

type NumericField = (typeof NUMERIC_FIELDS)[number]

interface BalanceData extends Record<NumericField, string> {
  positionsCount: number
  quoteUnit: Hip3Collateral
  pendingBalance?: string
  feeLevel?: number
  makerFee?: string
  takerFee?: string
  ordersCount?: number
}

interface DexResultSuccess {
  dex: DexId
  status: 'success'
  message: string
  data: BalanceData
}

interface DexResultError {
  dex: DexId
  status: 'error'
  message: string
  error: string
}

type DexResult = DexResultSuccess | DexResultError

type TotalsByQuoteUnit = Partial<Record<Hip3Collateral, Record<NumericField, string> & {
  quoteUnit: Hip3Collateral
  positionsCount: number
}>>

interface AllBalancesResponse {
  status: 'success' | 'partial'
  message: string
  data: {
    balances: Record<DexId, DexResult>
    totalsByQuoteUnit: TotalsByQuoteUnit
    summary: {
      positionsCount: number
      dexesReporting: number
      dexesFailed: number
      dexesTotal: number
    }
  }
}

const EMPTY_USDC_DATA: BalanceData = {
  accountValue: '0',
  accountEquity: '0',
  availableToTrade: '0',
  withdrawable: '0',
  totalMarginUsed: '0',
  totalPositionValue: '0',
  positionsCount: 0,
  quoteUnit: 'USDC',
}

function ok(dex: DexId, message: string, data: BalanceData): DexResultSuccess {
  return { dex, status: 'success', message, data }
}

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = parseFloat(value ?? '0')
  return Number.isFinite(parsed) ? parsed : 0
}

async function wrap(dex: DexId, fn: () => Promise<DexResult>): Promise<DexResult> {
  try {
    return await fn()
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    log.error(`[arb/balance/all] ${dex} error:`, msg)
    return {
      dex,
      status: 'error',
      message: `Failed to get ${dex} balance`,
      error: msg,
    }
  }
}

// `dexName` is empty for the main USDC venue, or the HIP-3 dex name for builder dexes.
function fetchHyperliquidVenue(
  id: DexId,
  ethAddress: string | null,
  dexName: string,
  quoteUnit: Hip3Collateral,
): Promise<DexResult> {
  return wrap(id, async () => {
    if (!ethAddress) {
      return ok(
        id,
        'No Ethereum wallet found — Hyperliquid account not created yet',
        { ...EMPTY_USDC_DATA, quoteUnit },
      )
    }

    const client = createHyperliquidClient(ethAddress, false)
    const state = await client.getClearinghouseState(undefined, dexName)

    const positionsCount = state.assetPositions.filter(
      ap => parseFloat(ap.position.szi) !== 0,
    ).length

    return ok(id, 'Balance retrieved successfully', {
      accountValue: state.crossMarginSummary.accountValue,
      accountEquity: state.marginSummary.accountValue,
      availableToTrade: (
        parseFloat(state.crossMarginSummary.accountValue) -
        parseFloat(state.crossMarginSummary.totalMarginUsed)
      ).toFixed(2),
      withdrawable: state.withdrawable,
      totalMarginUsed: state.crossMarginSummary.totalMarginUsed,
      totalPositionValue: state.crossMarginSummary.totalNtlPos,
      positionsCount,
      quoteUnit,
    })
  })
}

function fetchAster(
  userId: string,
  solanaWallet: { address: string; walletId: string } | null,
): Promise<DexResult> {
  return wrap('aster', async () => {
    if (!solanaWallet) {
      return ok('aster', 'No embedded Solana wallet found — Aster account not created yet', EMPTY_USDC_DATA)
    }

    const creds = await getOrCreateAsterApiCredentials(
      userId,
      solanaWallet.address,
      solanaWallet.walletId,
      getAuthorizationContext(),
    )

    const client = createAsterClient()
    client.setApiCredentials(creds.apiKey, creds.apiSecret)

    const [balances, positions] = await Promise.all([
      client.getBalance(),
      client.getPositionRisk().catch(() => []),
    ])

    let totalBalance = 0
    let totalAvailable = 0
    let totalCrossUnPnl = 0
    let totalMaxWithdraw = 0
    let totalPositionValue = 0

    for (const entry of balances) {
      totalBalance += toNumber(entry.balance)
      totalAvailable += toNumber(entry.availableBalance)
      totalCrossUnPnl += toNumber(entry.crossUnPnl)
      totalMaxWithdraw += toNumber(entry.maxWithdrawAmount)
    }

    const nonZeroPositions = positions.filter(p => toNumber(p.positionAmt) !== 0)
    const positionsCount = nonZeroPositions.length
    for (const position of nonZeroPositions) {
      totalPositionValue += Math.abs(toNumber(position.notional))
    }

    return ok('aster', 'Balance retrieved successfully', {
      accountValue: totalBalance.toFixed(2),
      accountEquity: (totalBalance + totalCrossUnPnl).toFixed(2),
      availableToTrade: totalAvailable.toFixed(2),
      withdrawable: totalMaxWithdraw.toFixed(2),
      totalMarginUsed: (totalBalance - totalAvailable).toFixed(2),
      totalPositionValue: totalPositionValue.toFixed(2),
      positionsCount,
      quoteUnit: 'USDC',
    })
  })
}

function fetchLighter(ethAddress: string | null): Promise<DexResult> {
  return wrap('lighter', async () => {
    if (!ethAddress) {
      return ok('lighter', 'No Ethereum wallet found — Lighter account not created yet', EMPTY_USDC_DATA)
    }

    const client = createLighterClient()
    const account = await client.getDetailedAccountByL1Address(ethAddress)
    if (!account) {
      return ok('lighter', 'No Lighter account found for this wallet', EMPTY_USDC_DATA)
    }

    const balance = toNumber(account.balance)
    const availableBalance = toNumber(account.available_balance)

    let totalPositionValue = 0
    let totalUnrealizedPnl = 0
    const positions = account.positions || []
    const positionsCount = positions.filter(p => parseFloat(p.position) !== 0).length

    for (const pos of positions) {
      totalPositionValue += Math.abs(toNumber(pos.position_value))
      totalUnrealizedPnl += toNumber(pos.unrealized_pnl)
    }

    return ok('lighter', 'Balance retrieved successfully', {
      accountValue: balance.toFixed(2),
      accountEquity: (balance + totalUnrealizedPnl).toFixed(2),
      availableToTrade: availableBalance.toFixed(2),
      withdrawable: availableBalance.toFixed(2),
      totalMarginUsed: (balance - availableBalance).toFixed(2),
      totalPositionValue: totalPositionValue.toFixed(2),
      positionsCount,
      quoteUnit: 'USDC',
    })
  })
}

function fetchZo(solanaAddress: string | null): Promise<DexResult> {
  return wrap('01', async () => {
    if (!solanaAddress) {
      return ok('01', 'No Solana wallet found — 01 account not created yet', EMPTY_USDC_DATA)
    }

    const client = createZoClient()
    const userInfoPromise = client.getUserInfo(solanaAddress)
    const accountPromise = userInfoPromise.then(u =>
      u?.accountIds?.length ? client.getAccount(u.accountIds[0]) : null,
    )
    const [userInfo, { tokenById }, account] = await Promise.all([
      userInfoPromise,
      getZoInfoCache(client),
      accountPromise,
    ])

    if (!userInfo || userInfo.accountIds.length === 0) {
      return ok('01', 'No 01 account found for this wallet', EMPTY_USDC_DATA)
    }
    if (!account) {
      return ok('01', '01 account not found', EMPTY_USDC_DATA)
    }

    let usdcBalance = 0
    for (const b of account.balances ?? []) {
      const tok = tokenById.get(b.tokenId)
      if (tok?.symbol.toUpperCase() === 'USDC') usdcBalance += b.amount
    }

    // `margins.imf` is the initial margin requirement in USD per the Nord
    // AccountMargins schema. Available-to-trade is the free collateral above that.
    const initialMargin = account.margins?.imf ?? 0
    const availableToTrade = Math.max(usdcBalance - initialMargin, 0)

    let totalPositionValue = 0
    let positionsCount = 0
    for (const pos of account.positions ?? []) {
      if (!pos.perp) continue
      const baseSize = pos.perp.baseSize
      if (!Number.isFinite(baseSize) || baseSize === 0) continue
      positionsCount++
      totalPositionValue += Math.abs(baseSize) * (pos.perp.price ?? 0)
    }

    return ok('01', 'Balance retrieved successfully', {
      accountValue: usdcBalance.toFixed(2),
      accountEquity: usdcBalance.toFixed(2),
      availableToTrade: availableToTrade.toFixed(2),
      withdrawable: availableToTrade.toFixed(2),
      totalMarginUsed: initialMargin.toFixed(2),
      totalPositionValue: totalPositionValue.toFixed(2),
      positionsCount,
      quoteUnit: 'USDC',
    })
  })
}

function fetchPhoenix(solanaAddress: string | null): Promise<DexResult> {
  return wrap('phoenix', async () => {
    if (!solanaAddress) {
      return ok('phoenix', 'No Solana wallet found — Phoenix account not created yet', EMPTY_USDC_DATA)
    }

    const provider = createPhoenixArbProvider()
    const balance = await provider.getBalance(solanaAddress)

    return ok('phoenix', 'Balance retrieved successfully', {
      accountValue: balance.accountEquityUsdc.toFixed(2),
      accountEquity: balance.accountEquityUsdc.toFixed(2),
      availableToTrade: balance.freeUsdc.toFixed(2),
      withdrawable: balance.freeUsdc.toFixed(2),
      totalMarginUsed: balance.lockedUsdc.toFixed(2),
      totalPositionValue: balance.totalPositionValueUsdc.toFixed(2),
      positionsCount: balance.positionsCount,
      quoteUnit: 'USDC',
    })
  })
}

function fetchPacifica(solanaAddress: string | null): Promise<DexResult> {
  return wrap('pacifica', async () => {
    if (!solanaAddress) {
      return ok('pacifica', 'No embedded Solana wallet found — Pacifica account not created yet', EMPTY_USDC_DATA)
    }

    let apiUrl = `${PACIFICA_API_BASE}/api/v1/account?account=${solanaAddress}`
    const headers: Record<string, string> = {}

    const ipv4 = getPacificaIPv4()
    if (ipv4) {
      apiUrl = apiUrl.replace(PACIFICA_HOST, ipv4)
      headers['Host'] = PACIFICA_HOST
    }

    const response = await fetch(apiUrl, { headers })
    if (!response.ok) {
      throw new Error((await response.text()) || `HTTP ${response.status}`)
    }

    const result = await response.json() as { success?: boolean; data?: any }
    if (!result.success || !result.data) {
      return ok('pacifica', 'No Pacifica account found for this wallet', EMPTY_USDC_DATA)
    }

    const d = result.data
    return ok('pacifica', 'Balance retrieved successfully', {
      accountValue: d.balance,
      accountEquity: d.account_equity,
      availableToTrade: d.available_to_spend,
      withdrawable: d.available_to_withdraw,
      totalMarginUsed: d.total_margin_used,
      totalPositionValue: '0',
      positionsCount: d.positions_count,
      pendingBalance: d.pending_balance,
      feeLevel: d.fee_level,
      makerFee: d.maker_fee,
      takerFee: d.taker_fee,
      ordersCount: d.orders_count,
      quoteUnit: 'USDC',
    })
  })
}

export async function allBalancesHandler(c: Context) {
  const authData = c.privyUser
  if (!authData) {
    return c.json(
      {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      },
      401,
    )
  }

  const linkedAccounts = authData.user.linked_accounts || []
  const ethAddr = extractEmbeddedEthWallet(linkedAccounts)?.address ?? null
  const solanaWallet = extractEmbeddedSolanaWallet(linkedAccounts)
  const solAddr = solanaWallet?.address ?? null

  log.info(`[arb/balance/all] Fetching all balances for user ${authData.user.id}`)

  const hip3Tasks = HIP3_DEX_NAMES.map((name: Hip3DexName) =>
    fetchHyperliquidVenue(
      getHip3ProtocolId(name),
      ethAddr,
      name,
      getHip3Collateral(name),
    ),
  )

  const results = await Promise.all([
    fetchHyperliquidVenue('hyperliquid', ethAddr, '', 'USDC'),
    ...hip3Tasks,
    fetchAster(authData.user.id, solanaWallet),
    fetchLighter(ethAddr),
    fetchZo(solAddr),
    fetchPacifica(solAddr),
    fetchPhoenix(solAddr),
  ])

  const balances = {} as Record<DexId, DexResult>
  let positionsCount = 0
  let dexesReporting = 0
  let dexesFailed = 0
  const totalsByQuoteUnit = {} as Partial<Record<Hip3Collateral, {
    quoteUnit: Hip3Collateral
    positionsCount: number
  } & Record<NumericField, number>>>

  for (const r of results) {
    balances[r.dex] = r
    if (r.status === 'success') {
      dexesReporting++
      const quoteUnit = r.data.quoteUnit
      const bucket = totalsByQuoteUnit[quoteUnit] ?? {
        quoteUnit,
        accountValue: 0,
        accountEquity: 0,
        availableToTrade: 0,
        withdrawable: 0,
        totalMarginUsed: 0,
        totalPositionValue: 0,
        positionsCount: 0,
      }
      for (const f of NUMERIC_FIELDS) bucket[f] += toNumber(r.data[f])
      bucket.positionsCount += r.data.positionsCount || 0
      totalsByQuoteUnit[quoteUnit] = bucket
      positionsCount += r.data.positionsCount || 0
    } else {
      dexesFailed++
    }
  }

  const normalizedTotalsByQuoteUnit = Object.fromEntries(
    Object.entries(totalsByQuoteUnit).map(([quoteUnit, bucket]) => [
      quoteUnit,
      {
        quoteUnit: bucket.quoteUnit,
        ...(Object.fromEntries(
          NUMERIC_FIELDS.map(f => [f, bucket[f].toFixed(2)]),
        ) as Record<NumericField, string>),
        positionsCount: bucket.positionsCount,
      },
    ]),
  ) as TotalsByQuoteUnit

  const isPartial = dexesFailed > 0

  const response: AllBalancesResponse = {
    status: isPartial ? 'partial' : 'success',
    message: isPartial
      ? `Balances retrieved with ${dexesFailed} provider failure${dexesFailed === 1 ? '' : 's'}`
      : 'Balances retrieved',
    data: {
      balances,
      totalsByQuoteUnit: normalizedTotalsByQuoteUnit,
      summary: {
        positionsCount,
        dexesReporting,
        dexesFailed,
        dexesTotal: results.length,
      },
    },
  }

  return c.json(response, isPartial ? 207 : 200)
}
