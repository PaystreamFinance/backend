import { Hono } from 'hono'
import { spotPerpTradeHandler } from './spot-perp'
import { spotPerpPositionsHandler } from './spot-perp-positions'
import { spotPerpCloseHandler } from './spot-perp-close'

const tradeRouter = new Hono()

// POST /api/trade/spot-perp - Create spot-perp hedge (spot buy + perp short)
tradeRouter.post('/spot-perp', spotPerpTradeHandler)

// GET /api/trade/spot-perp/positions - List active spot-perp positions
tradeRouter.get('/spot-perp/positions', spotPerpPositionsHandler)

// POST /api/trade/spot-perp/close - Close a spot-perp position
tradeRouter.post('/spot-perp/close', spotPerpCloseHandler)

export { tradeRouter }
