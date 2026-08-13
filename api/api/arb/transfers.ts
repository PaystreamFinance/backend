import type { Context } from 'hono'
import type {
  TransferRecord,
  TransferProtocol,
  TransfersSuccessResponse,
  TransfersErrorResponse,
} from '../../models/arb'
import { log } from '../../utils/log'
import { extractEmbeddedSolanaWallet, extractEmbeddedEthWallet } from '../../utils/wallet'
import {
  fetchHyperliquidTransfers,
  fetchPacificaTransfers,
  fetchLighterTransfers,
  fetchAsterTransfers,
  fetchZoTransfers,
} from './transfer-fetchers'

const VALID_TYPES = ['deposit', 'withdrawal', 'all'] as const
const VALID_PROTOCOLS = ['pacifica', 'hyperliquid', 'aster', 'lighter', '01', 'phoenix', 'all'] as const

/**
 * GET /api/arb/transfers
 * Returns transfer history with pagination.
 *
 * For Hyperliquid, Pacifica, Lighter, Aster: fetches directly from DEX APIs.
 */
export async function transfersHandler(c: Context) {
  try {
    const authData = c.privyUser

    if (!authData) {
      const response: TransfersErrorResponse = {
        status: 'error',
        message: 'User not authenticated',
        error: 'Authentication required',
      }
      return c.json(response, 401)
    }

    const privyUserId = authData.user.id

    // Parse and validate query params
    const typeParam = c.req.query('type') || 'all'
    const protocolParam = c.req.query('protocol') || 'all'
    const limitParam = c.req.query('limit')
    const offsetParam = c.req.query('offset')

    if (!VALID_TYPES.includes(typeParam as (typeof VALID_TYPES)[number])) {
      const response: TransfersErrorResponse = {
        status: 'error',
        message: `Invalid type filter: "${typeParam}". Must be one of: ${VALID_TYPES.join(', ')}`,
      }
      return c.json(response, 400)
    }

    if (!VALID_PROTOCOLS.includes(protocolParam as (typeof VALID_PROTOCOLS)[number])) {
      const response: TransfersErrorResponse = {
        status: 'error',
        message: `Invalid protocol filter: "${protocolParam}". Must be one of: ${VALID_PROTOCOLS.join(', ')}`,
      }
      return c.json(response, 400)
    }

    const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 100)
    const offset = Math.max(Number(offsetParam) || 0, 0)

    // Extract wallet addresses from Privy user
    const linkedAccounts = authData.user.linked_accounts || []
    const solWallet = extractEmbeddedSolanaWallet(linkedAccounts)
    const ethWallet = extractEmbeddedEthWallet(linkedAccounts)

    const requestedProtocol = protocolParam as TransferProtocol | 'all'

    // Collect transfer records from each requested API in parallel
    const fetchPromises: Promise<TransferRecord[]>[] = []

    if ((requestedProtocol === 'all' || requestedProtocol === 'hyperliquid') && ethWallet) {
      fetchPromises.push(fetchHyperliquidTransfers(ethWallet.address))
    }
    if ((requestedProtocol === 'all' || requestedProtocol === 'pacifica') && solWallet) {
      fetchPromises.push(fetchPacificaTransfers(solWallet.address))
    }
    if ((requestedProtocol === 'all' || requestedProtocol === 'lighter') && ethWallet) {
      fetchPromises.push(fetchLighterTransfers(privyUserId, ethWallet.address))
    }
    if (requestedProtocol === 'all' || requestedProtocol === 'aster') {
      fetchPromises.push(fetchAsterTransfers(privyUserId))
    }
    if ((requestedProtocol === 'all' || requestedProtocol === '01') && solWallet) {
      fetchPromises.push(fetchZoTransfers(solWallet.address))
    }

    const results = await Promise.all(fetchPromises)
    let allTransfers = results.flat()

    // Apply type filter (API fetchers return all types, so filter here)
    if (typeParam !== 'all') {
      allTransfers = allTransfers.filter(t => t.type === typeParam)
    }

    // ISO 8601 strings are lexicographically sortable
    allTransfers.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0))

    // Apply pagination
    const total = allTransfers.length
    const paginatedTransfers = allTransfers.slice(offset, offset + limit)

    const response: TransfersSuccessResponse = {
      status: 'success',
      transfers: paginatedTransfers,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + limit < total,
      },
    }

    return c.json(response)
  } catch (err) {
    log.error('Failed to fetch transfers:', err)
    const response: TransfersErrorResponse = {
      status: 'error',
      message: 'Failed to fetch transfers',
      error: err instanceof Error ? err.message : String(err),
    }
    return c.json(response, 500)
  }
}
