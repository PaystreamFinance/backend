import { Hono } from 'hono'
import { privyAuthMiddleware } from '../../middleware/auth'
import { depositHandler } from './deposit'
import { withdrawHandler } from './withdraw'
import { balanceHandler } from './balance'

const pacificaRouter = new Hono()

// All Pacifica routes require Privy auth
pacificaRouter.use('*', privyAuthMiddleware)

// GET /api/pacifica/balance - Get user's Pacifica account balance
pacificaRouter.get('/balance', balanceHandler)

// POST /api/pacifica/deposit - Deposit USDC to Pacifica
pacificaRouter.post('/deposit', depositHandler)

// POST /api/pacifica/withdraw - Withdraw USDC from Pacifica
pacificaRouter.post('/withdraw', withdrawHandler)

export { pacificaRouter }
