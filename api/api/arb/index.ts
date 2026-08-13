import { Hono } from 'hono'
import { privyAuthMiddleware } from '../../middleware/auth'
import { marketsHandler } from './markets'
import { tradeHandler } from './trade'
import { tradeV2Handler } from './trade-v2'
import { positionsHandler } from './positions'
import { positionsV2Handler } from './positions-v2'
import { closeHandler } from './close'
import { closeAllHandler } from './close-all'
import { activityHandler } from './activity'
import { transfersHandler } from './transfers'
import { feesHandler } from './fees'
import { fundingRatesHistoryHandler } from './funding-rates/history'
import { fundingRatesHistoryByDexHandler } from './funding-rates/dex'
import { hyperliquidDepositInfoHandler, hyperliquidDepositHandler, hyperliquidDepositAddressHandler, hyperliquidConvertHandler } from './deposit/hyperliquid'
import { asterDepositHandler } from './deposit/aster'
import { lighterDepositHandler, lighterDepositStatusHandler } from './deposit/lighter'
import { setTpSlHandler } from './set-tp-sl'
import { tpSlLookupHandler } from './tp-sl'
import { fundingHistoryHandler } from './activity/funding-history'
import { hyperliquidBalanceHandler } from './balance/hyperliquid'
import { asterBalanceHandler } from './balance/aster'
import { lighterBalanceHandler } from './balance/lighter'
import { zoBalanceHandler } from './balance/01'
import { phoenixBalanceHandler } from './balance/phoenix'
import { allBalancesHandler } from './balance/all'
import { hyperliquidWithdrawHandler } from './withdraw/hyperliquid'
import { asterWithdrawHandler } from './withdraw/aster'
import { lighterWithdrawHandler } from './withdraw/lighter'
import { zoWithdrawHandler } from './withdraw/01'
import { zoDepositHandler } from './deposit/01'
import { phoenixDepositHandler } from './deposit/phoenix'
import { phoenixWithdrawHandler } from './withdraw/phoenix'

const arbRouter = new Hono()

// Public endpoints (no auth required)
arbRouter.get('/funding-rates/history', fundingRatesHistoryHandler)
// Shared history (up to 30d). Optional ?symbol=, ?days= (max 30), ?order=asc|desc.
// Per-dex deep history (up to 30d). Required ?symbol=, optional ?days= (max 30), ?order=asc|desc.
arbRouter.get('/funding-rates/history/:dex', fundingRatesHistoryByDexHandler)
arbRouter.get('/markets', marketsHandler)

// All remaining arb routes require Privy auth
arbRouter.use('*', privyAuthMiddleware)

// GET /api/arb/fees - Get fee structure per DEX for the authenticated user
arbRouter.get('/fees', feesHandler)

// POST /api/arb/trade - Execute arbitrage by opening hedged positions
arbRouter.post('/trade', tradeHandler)

// POST /api/arb/trade/v2 - Open hedged positions with distinct per-leg tickers
// (e.g. XAU on Pacifica + GOLD on Hyperliquid for the same underlying asset)
arbRouter.post('/trade/v2', tradeV2Handler)

// GET /api/arb/positions - Fetch open arbitrage positions from both protocols
arbRouter.get('/positions', positionsHandler)

// GET /api/arb/positions/v2 - Pair-centric positions with risk tags and live data
arbRouter.get('/positions/v2', positionsV2Handler)

// GET /api/arb/activity - Fetch historical arb position activity with pagination
arbRouter.get('/activity', activityHandler)

// GET /api/arb/activity/funding/history - Fetch historical funding payments from all DEXes
arbRouter.get('/activity/funding/history', fundingHistoryHandler)

// GET /api/arb/transfers - Fetch deposit/withdrawal history with pagination
arbRouter.get('/transfers', transfersHandler)

// POST /api/arb/close - Close arbitrage positions on both protocols
arbRouter.post('/close', closeHandler)

// POST /api/arb/close-all - Close all open positions across all protocols
arbRouter.post('/close-all', closeAllHandler)

// POST /api/arb/set-tp-sl - Set take-profit or stop-loss on existing positions
arbRouter.post('/set-tp-sl', setTpSlHandler)

// POST /api/arb/tp-sl - Fetch TP/SL trigger prices for specific protocol+ticker pairs
arbRouter.post('/tp-sl', tpSlLookupHandler)

// Deposits
arbRouter.get('/deposit/hyperliquid', hyperliquidDepositInfoHandler)
arbRouter.post('/deposit/hyperliquid', hyperliquidDepositHandler)
arbRouter.post('/deposit/hyperliquid/convert', hyperliquidConvertHandler)
arbRouter.get('/deposit/hyperliquid/:asset', hyperliquidDepositAddressHandler)
arbRouter.post('/deposit/aster', asterDepositHandler)
arbRouter.post('/deposit/lighter', lighterDepositHandler)
arbRouter.get('/deposit/lighter/status', lighterDepositStatusHandler)
arbRouter.post('/deposit/01', zoDepositHandler)
arbRouter.post('/deposit/phoenix', phoenixDepositHandler)

// Balances
// GET /api/arb/balance - Aggregated balances across all DEXes (parallel fan-out)
arbRouter.get('/balance', allBalancesHandler)
arbRouter.get('/balance/hyperliquid', hyperliquidBalanceHandler)
arbRouter.get('/balance/aster', asterBalanceHandler)
arbRouter.get('/balance/lighter', lighterBalanceHandler)
arbRouter.get('/balance/01', zoBalanceHandler)
arbRouter.get('/balance/phoenix', phoenixBalanceHandler)

// Withdrawals
arbRouter.post('/withdraw/hyperliquid', hyperliquidWithdrawHandler)
arbRouter.post('/withdraw/aster', asterWithdrawHandler)
arbRouter.post('/withdraw/lighter', lighterWithdrawHandler)
arbRouter.post('/withdraw/01', zoWithdrawHandler)
arbRouter.post('/withdraw/phoenix', phoenixWithdrawHandler)

export { arbRouter }
