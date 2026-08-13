import { Hono } from 'hono'
import { serviceAuthMiddleware } from '../../middleware/service-auth'
import { notifyHandler } from './routes/notify.js'
import { broadcastHandler } from './routes/broadcast.js'

const app = new Hono()

// Health check (no auth)
app.get('/', (c) => c.json({ status: 'ok', service: 'telegram-bot' }))

// All API routes require service-key auth
app.use('/*', serviceAuthMiddleware)
app.post('/notify', notifyHandler)
app.post('/broadcast', broadcastHandler)

export { app as apiApp }
