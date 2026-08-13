import { Hono } from 'hono'
import { privyAuthMiddleware } from '../middleware/auth'
import { swapRouter } from './swap'
import { tradeRouter } from './trade'
import { arbRouter } from './arb'
import { pacificaRouter } from './pacifica'
import { internalArbCloseHandler } from './internal/arb-close'
import { internalArbPositionsHandler } from './internal/arb-positions'
import { internalArbSetStopLossHandler } from './internal/arb-set-stop-loss'
import { internalSpotPerpCloseHandler } from './internal/spot-perp-close'
import { linkTokenHandler } from './telegram/link-token'
import { apiApp as telegramApiApp } from '../telegram/api'
import { statsHandler } from './stats/volume'
import { weeklyStatsHandler } from './stats/weekly'
import { notificationsRouter } from './notifications'
import { serviceAuthMiddleware } from '../middleware/service-auth'

const apiRouter = new Hono()

// Internal routes (service-key auth, no Privy)
const internalRouter = new Hono()
internalRouter.use('*', serviceAuthMiddleware)
internalRouter.post('/arb/close', internalArbCloseHandler)
internalRouter.post('/arb/positions', internalArbPositionsHandler)
internalRouter.post('/arb/set-stop-loss', internalArbSetStopLossHandler)
internalRouter.post('/spot-perp/close', internalSpotPerpCloseHandler)
apiRouter.route('/internal', internalRouter)

// Telegram notification routes (service-key auth, handled internally)
apiRouter.route('/telegram/bot', telegramApiApp)

// Public routes (no auth required)
apiRouter.route('/arb', arbRouter) // Auth handled per-route in arbRouter
apiRouter.get('/stats', statsHandler)
apiRouter.get('/stats/weekly', weeklyStatsHandler)

// Protected routes (require Privy auth)
apiRouter.use('/swap/*', privyAuthMiddleware)
apiRouter.use('/trade/*', privyAuthMiddleware)
apiRouter.use('/pacifica/*', privyAuthMiddleware)
apiRouter.use('/telegram/*', privyAuthMiddleware)
apiRouter.use('/notifications/*', privyAuthMiddleware)

// Protected sub-routers
apiRouter.route('/swap', swapRouter)
apiRouter.route('/trade', tradeRouter)
apiRouter.route('/pacifica', pacificaRouter)
apiRouter.post('/telegram/link-token', linkTokenHandler)
apiRouter.route('/notifications', notificationsRouter)

export { apiRouter }
