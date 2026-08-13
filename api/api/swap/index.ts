import { Hono } from 'hono'
import { swapQuoteHandler } from './quote'
import { swapExecuteHandler } from './execute'
import { swapActivityHandler } from './activity'

const swapRouter = new Hono()

swapRouter.get('/quote', swapQuoteHandler)
swapRouter.post('/execute', swapExecuteHandler)
swapRouter.get('/activity', swapActivityHandler)

export { swapRouter }

