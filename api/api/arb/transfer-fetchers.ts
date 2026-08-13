import { createHmac } from 'crypto'
import type { TransferRecord } from '../../models/arb'
import { log } from '../../utils/log'
import { getStoredLighterCredentialsAsync } from '../../clients/arb/lighter-auth'
import { getStoredApiCredentialsAsync } from '../../clients/arb/aster-auth'
import { createClient, createAuthToken } from '@paystream/perps/lighter/signer'
import { PACIFICA_API_BASE } from '@paystream/perps/providers/pacifica-provider'
import {
  createZoClient,
  type ZoClient,
  type ZoDepositInfo,
  type ZoWithdrawalInfo,
  type ZoPageResult,
} from '@paystream/perps/clients/zo-client'
import { getZoInfoCache } from '../../clients/arb/zo-info-cache'

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info'
const LIGHTER_BASE_URL = 'https://mainnet.zklighter.elliot.ai'
const LIGHTER_CHAIN_ID = 304
const ASTER_BASE_URL = 'https://fapi.asterdex.com'
const FETCH_TIMEOUT_MS = 10_000

/** Max pages to fetch from Pacifica's cursor-paginated API. */
const PACIFICA_MAX_PAGES = 20

/** Only fetch HL ledger entries from the last 90 days. */
const HL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000

// ==================== Hyperliquid ====================

interface HLLedgerEntry {
  time: number
  hash: string
  delta:
    | { type: 'deposit'; usdc: string }
    | { type: 'withdraw'; usdc: string; nonce: number; fee: string }
    | { type: 'spotTransfer'; token: string; amount: string; usdcValue: string; user: string; destination: string; fee: string; nativeTokenFee: string; nonce: number | null; feeToken: string }
    | { type: 'send'; user: string; destination: string; sourceDex: string; destinationDex: string; token: string; amount: string; usdcValue: string; fee: string; nativeTokenFee: string; nonce: number; feeToken: string }
    | { type: string; [key: string]: any }
}

export async function fetchHyperliquidTransfers(ethAddress: string): Promise<TransferRecord[]> {
  try {
    const response = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userNonFundingLedgerUpdates',
        user: ethAddress,
        startTime: Date.now() - HL_LOOKBACK_MS,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      log.warn(`[transfer-fetchers] HL API error: ${response.status}`)
      return []
    }

    const entries: HLLedgerEntry[] = await response.json()
    const records: TransferRecord[] = []
    const userAddr = ethAddress.toLowerCase()

    // USOL is Unit Protocol's wrapped SOL — display as SOL for the user
    const normalizeAsset = (token: string) => token === 'USOL' ? 'SOL' : token

    for (const entry of entries) {
      const { delta } = entry
      const createdAt = new Date(entry.time).toISOString()

      if (delta.type === 'deposit') {
        records.push({
          publicId: `hl-deposit-${entry.hash}`,
          type: 'deposit',
          protocol: 'hyperliquid',
          asset: 'USDC',
          amount: parseFloat(delta.usdc),
          usdcValue: parseFloat(delta.usdc),
          status: 'confirmed',
          txHash: entry.hash,
          fromAddress: null,
          toAddress: ethAddress,
          metadata: { source: 'hyperliquid-api', deltaType: 'deposit' },
          createdAt,
          updatedAt: createdAt,
        })
      } else if (delta.type === 'withdraw') {
        records.push({
          publicId: `hl-withdraw-${entry.hash}`,
          type: 'withdrawal',
          protocol: 'hyperliquid',
          asset: 'USDC',
          amount: parseFloat(delta.usdc),
          usdcValue: parseFloat(delta.usdc),
          status: 'confirmed',
          txHash: entry.hash,
          fromAddress: ethAddress,
          toAddress: null,
          metadata: { source: 'hyperliquid-api', deltaType: 'withdraw', fee: delta.fee },
          createdAt,
          updatedAt: createdAt,
        })
      } else if (delta.type === 'spotTransfer' && delta.destination.toLowerCase() === userAddr) {
        records.push({
          publicId: `hl-spotTransfer-${entry.hash}`,
          type: 'deposit',
          protocol: 'hyperliquid',
          asset: normalizeAsset(delta.token),
          amount: parseFloat(delta.amount),
          usdcValue: parseFloat(delta.usdcValue),
          status: 'confirmed',
          txHash: entry.hash,
          fromAddress: delta.user,
          toAddress: ethAddress,
          metadata: { source: 'hyperliquid-api', deltaType: 'spotTransfer', usdcValue: delta.usdcValue },
          createdAt,
          updatedAt: createdAt,
        })
      } else if (delta.type === 'send' && delta.user.toLowerCase() === userAddr && delta.destination.toLowerCase() !== userAddr) {
        records.push({
          publicId: `hl-send-${entry.hash}`,
          type: 'withdrawal',
          protocol: 'hyperliquid',
          asset: normalizeAsset(delta.token),
          amount: parseFloat(delta.amount),
          usdcValue: parseFloat(delta.usdcValue),
          status: 'confirmed',
          txHash: entry.hash,
          fromAddress: ethAddress,
          toAddress: delta.destination,
          metadata: { source: 'hyperliquid-api', deltaType: 'send', usdcValue: delta.usdcValue, fee: delta.fee },
          createdAt,
          updatedAt: createdAt,
        })
      }
    }

    return records
  } catch (err) {
    log.error('[transfer-fetchers] Failed to fetch HL transfers:', err)
    return []
  }
}

// ==================== Pacifica ====================

interface PacificaBalanceEvent {
  amount: string
  balance: string
  pending_balance: string
  event_type: string
  created_at: number
}

export async function fetchPacificaTransfers(solanaAddress: string): Promise<TransferRecord[]> {
  try {
    const records: TransferRecord[] = []
    let cursor: string | undefined
    let hasMore = true
    let page = 0

    while (hasMore && page < PACIFICA_MAX_PAGES) {
      page++
      const url = new URL(`${PACIFICA_API_BASE}/api/v1/account/balance/history`)
      url.searchParams.set('account', solanaAddress)
      if (cursor) url.searchParams.set('cursor', cursor)

      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })

      if (!response.ok) {
        log.warn(`[transfer-fetchers] Pacifica API error: ${response.status}`)
        return records
      }

      const data = await response.json() as {
        success: boolean
        data: PacificaBalanceEvent[]
        next_cursor?: string
        has_more: boolean
      }

      if (!data.success) return records

      for (const event of data.data) {
        if (event.event_type !== 'deposit' && event.event_type !== 'withdraw') continue

        const createdAt = new Date(event.created_at).toISOString()
        const amount = Math.abs(parseFloat(event.amount))
        records.push({
          // Include balance to disambiguate events at the same timestamp
          publicId: `pacifica-${event.event_type}-${event.created_at}-${event.balance}`,
          type: event.event_type === 'deposit' ? 'deposit' : 'withdrawal',
          protocol: 'pacifica',
          asset: 'USDC',
          amount,
          usdcValue: amount,
          status: 'confirmed',
          txHash: null,
          fromAddress: event.event_type === 'deposit' ? null : solanaAddress,
          toAddress: event.event_type === 'deposit' ? solanaAddress : null,
          metadata: { source: 'pacifica-api', balance: event.balance },
          createdAt,
          updatedAt: createdAt,
        })
      }

      hasMore = data.has_more
      cursor = data.next_cursor
    }

    return records
  } catch (err) {
    log.error('[transfer-fetchers] Failed to fetch Pacifica transfers:', err)
    return []
  }
}

// ==================== Lighter ====================

interface LighterHistoryItem {
  id: string
  amount: string
  timestamp: number
  status: string
  l1_tx_hash: string
  asset_id: number
}

function mapLighterStatus(status: string): 'initiated' | 'confirmed' | 'failed' {
  switch (status) {
    case 'completed': return 'confirmed'
    case 'failed': return 'failed'
    case 'pending':
    case 'claimable':
    default: return 'initiated'
  }
}

export async function fetchLighterTransfers(privyUserId: string, ethAddress: string): Promise<TransferRecord[]> {
  try {
    const creds = await getStoredLighterCredentialsAsync(privyUserId)
    if (!creds) return []

    await createClient(LIGHTER_BASE_URL, creds.apiPrivateKey, LIGHTER_CHAIN_ID, creds.apiKeyIndex, creds.accountIndex)
    const deadline = Math.floor(Date.now() / 1000) + 600
    const authToken = await createAuthToken(deadline, creds.apiKeyIndex, creds.accountIndex)

    const [depositRes, withdrawRes] = await Promise.all([
      fetch(`${LIGHTER_BASE_URL}/api/v1/deposit/history?account_index=${creds.accountIndex}&l1_address=${ethAddress}`, {
        headers: { 'Authorization': authToken },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
      fetch(`${LIGHTER_BASE_URL}/api/v1/withdraw/history?account_index=${creds.accountIndex}&l1_address=${ethAddress}`, {
        headers: { 'Authorization': authToken },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
    ])

    const records: TransferRecord[] = []

    if (depositRes.ok) {
      const depositData = await depositRes.json() as { deposits?: LighterHistoryItem[] }
      for (const d of depositData.deposits ?? []) {
        const createdAt = new Date(d.timestamp).toISOString()
        const amount = parseFloat(d.amount)
        records.push({
          publicId: `lighter-deposit-${d.id}`,
          type: 'deposit',
          protocol: 'lighter',
          asset: 'USDC',
          amount,
          usdcValue: amount,
          status: mapLighterStatus(d.status),
          txHash: d.l1_tx_hash || null,
          fromAddress: ethAddress,
          toAddress: null,
          metadata: { source: 'lighter-api', lighterId: d.id, rawStatus: d.status, assetId: d.asset_id },
          createdAt,
          updatedAt: createdAt,
        })
      }
    } else {
      log.warn(`[transfer-fetchers] Lighter deposit history error: ${depositRes.status}`)
    }

    if (withdrawRes.ok) {
      const withdrawData = await withdrawRes.json() as { withdrawals?: LighterHistoryItem[] }
      for (const w of withdrawData.withdrawals ?? []) {
        const createdAt = new Date(w.timestamp).toISOString()
        const amount = parseFloat(w.amount)
        records.push({
          publicId: `lighter-withdraw-${w.id}`,
          type: 'withdrawal',
          protocol: 'lighter',
          asset: 'USDC',
          amount,
          usdcValue: amount,
          status: mapLighterStatus(w.status),
          txHash: w.l1_tx_hash || null,
          fromAddress: null,
          toAddress: ethAddress,
          metadata: { source: 'lighter-api', lighterId: w.id, rawStatus: w.status, assetId: w.asset_id },
          createdAt,
          updatedAt: createdAt,
        })
      }
    } else {
      log.warn(`[transfer-fetchers] Lighter withdraw history error: ${withdrawRes.status}`)
    }

    return records
  } catch (err) {
    log.error('[transfer-fetchers] Failed to fetch Lighter transfers:', err)
    return []
  }
}

// ==================== Aster ====================

interface AsterDepositWithdrawRecord {
  id: string
  type: 'DEPOSIT' | 'WITHDRAW'
  asset: string
  amount: string
  state: 'PROCESSING' | 'SUCCESS' | 'FAILED'
  txHash: string
  time: number
  chainId: number
  accountType: string
}

function mapAsterStatus(state: string): 'initiated' | 'confirmed' | 'failed' {
  switch (state) {
    case 'SUCCESS': return 'confirmed'
    case 'FAILED': return 'failed'
    case 'PROCESSING':
    default: return 'initiated'
  }
}

export async function fetchAsterTransfers(privyUserId: string): Promise<TransferRecord[]> {
  try {
    const creds = await getStoredApiCredentialsAsync(privyUserId)
    if (!creds) return []

    const timestamp = Date.now()
    const queryString = `timestamp=${timestamp}&recvWindow=5000`
    const signature = createHmac('sha256', creds.apiSecret)
      .update(queryString)
      .digest('hex')

    const url = `${ASTER_BASE_URL}/fapi/aster/deposit-withdraw-history?${queryString}&signature=${signature}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': creds.apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      log.warn(`[transfer-fetchers] Aster API error: ${response.status}`)
      return []
    }

    const data: AsterDepositWithdrawRecord[] = await response.json()
    return data.map((r) => {
      const createdAt = new Date(r.time).toISOString()
      const amount = parseFloat(r.amount)
      return {
        publicId: `aster-${r.type.toLowerCase()}-${r.id}`,
        type: r.type === 'DEPOSIT' ? 'deposit' as const : 'withdrawal' as const,
        protocol: 'aster' as const,
        asset: r.asset,
        amount,
        usdcValue: amount,
        status: mapAsterStatus(r.state),
        txHash: r.txHash || null,
        fromAddress: null,
        toAddress: null,
        metadata: { source: 'aster-api', asterId: r.id, chainId: r.chainId, accountType: r.accountType, rawState: r.state },
        createdAt,
        updatedAt: createdAt,
      }
    })
  } catch (err) {
    log.error('[transfer-fetchers] Failed to fetch Aster transfers:', err)
    return []
  }
}

// ==================== 01 ====================

/** Max pages to fetch from 01's history endpoints (50 items/page default). */
const ZO_MAX_PAGES = 20

/** Wall-clock budget for a full fetchZoTransfers call; prevents stalls from blocking the outer /transfers response. */
const ZO_FETCH_BUDGET_MS = 15_000

async function fetchAllZoPages<T>(
  pageFetcher: (startInclusive?: number) => Promise<ZoPageResult<T>>,
  deadline: number,
): Promise<T[]> {
  const items: T[] = []
  let startInclusive: number | undefined
  for (let page = 0; page < ZO_MAX_PAGES; page++) {
    if (Date.now() > deadline) break
    const res = await pageFetcher(startInclusive)
    items.push(...res.items)
    if (res.nextStartInclusive == null) break
    startInclusive = res.nextStartInclusive
  }
  return items
}

export async function fetchZoTransfers(solanaAddress: string): Promise<TransferRecord[]> {
  try {
    const client = createZoClient()
    const deadline = Date.now() + ZO_FETCH_BUDGET_MS

    const [userInfo, { tokenSymbolById }] = await Promise.all([
      client.getUserInfo(solanaAddress),
      getZoInfoCache(client),
    ])
    if (!userInfo || userInfo.accountIds.length === 0) return []

    const assetFor = (tokenId: number) => tokenSymbolById.get(tokenId) ?? `TOKEN_${tokenId}`

    const perAccount = await Promise.all(
      userInfo.accountIds.map(async (accountId) => {
        const [deposits, withdrawals] = await Promise.all([
          fetchAllZoPages<ZoDepositInfo>(s => client.getDepositHistory(accountId, s), deadline),
          fetchAllZoPages<ZoWithdrawalInfo>(s => client.getWithdrawalHistory(accountId, s), deadline),
        ])
        return { accountId, deposits, withdrawals }
      }),
    )

    const records: TransferRecord[] = []
    for (const { accountId, deposits, withdrawals } of perAccount) {
      for (const d of deposits) {
        records.push({
          publicId: `01-deposit-${d.actionId}`,
          type: 'deposit',
          protocol: '01',
          asset: assetFor(d.tokenId),
          amount: d.amount,
          usdcValue: d.amount,
          status: 'confirmed',
          txHash: null,
          fromAddress: solanaAddress,
          toAddress: null,
          metadata: { source: '01-api', actionId: d.actionId, accountId, tokenId: d.tokenId, balance: d.balance },
          createdAt: d.time,
          updatedAt: d.time,
        })
      }
      for (const w of withdrawals) {
        records.push({
          publicId: `01-withdraw-${w.actionId}`,
          type: 'withdrawal',
          protocol: '01',
          asset: assetFor(w.tokenId),
          amount: w.amount,
          usdcValue: w.amount,
          status: 'confirmed',
          txHash: null,
          fromAddress: null,
          toAddress: w.destPubkey ?? solanaAddress,
          metadata: { source: '01-api', actionId: w.actionId, accountId, tokenId: w.tokenId, fee: w.fee, balance: w.balance },
          createdAt: w.time,
          updatedAt: w.time,
        })
      }
    }

    return records
  } catch (err) {
    log.error('[transfer-fetchers] Failed to fetch 01 transfers:', err)
    return []
  }
}
