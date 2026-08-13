// IMPORTANT: Import instrumentation FIRST before any other imports
// This ensures all modules are properly instrumented by OpenTelemetry
import './instrumentation'

import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { log } from './utils/log'
import { setLogger } from '@paystream/perps/logger'
import './clients/privy'
import { apiRouter } from './api'
import { cors } from 'hono/cors'
import { SOLANA_NETWORK } from './utils/constants'
import { initializeTipAccounts } from './utils/tipAccounts'
import { otelMiddleware } from './middleware/otel'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'
import { initializeArbRegistry } from '@paystream/perps/registry'
import { startHlConversionPoller } from './services/hl-conversion-poller'
import { startBot } from './telegram/bot'
import { createMarkPriceFeed, priceWebSocketHandler } from './services/mark-price-feed'
import { validateServiceAuthConfig } from './middleware/service-auth'

// Inject OTel logger into @paystream/perps so shared code uses structured logging
setLogger(log)

// Prevent unhandled errors from crashing the process (e.g. transient RPC 502s)
process.on('unhandledRejection', (reason) => {
  log.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason)
  sendOpsAlert({
    key: 'api-unhandled-rejection',
    severity: AlertSeverity.CRITICAL,
    title: 'Unhandled rejection in API',
    message: reason instanceof Error ? reason.message : String(reason),
    service: 'api',
    error: reason,
  })
})
process.on('uncaughtException', (error) => {
  log.error('[uncaughtException]', error.message)
  sendOpsAlert({
    key: 'api-uncaught-exception',
    severity: AlertSeverity.CRITICAL,
    title: 'Uncaught exception in API',
    message: error.message,
    service: 'api',
    error,
  })
  // Only exit on truly fatal errors, not transient network issues
  if (error.message?.includes('EADDRINUSE')) {
    process.exit(1)
  }
})

// Clean shutdown on SIGINT/SIGTERM
let shutdownInProgress = false
let markPriceFeed: ReturnType<typeof createMarkPriceFeed> | null = null
function shutdown(signal: string) {
  if (shutdownInProgress) {
    log.warn(`[shutdown] Forced exit (${signal})`)
    process.exit(1)
  }
  shutdownInProgress = true
  log.info(`[shutdown] ${signal} received, exiting...`)
  markPriceFeed?.stop()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

const app = new Hono()

validateServiceAuthConfig()

const allowedOrigins = Bun.env.CORS_ORIGINS
  ?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean) ??
  (Bun.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000'])

/* Middleware */
app.use(otelMiddleware) // OpenTelemetry tracing - must be first
app.use(logger(log))
app.use(cors({
  origin: allowedOrigins,
  allowHeaders: ['Authorization', 'Content-Type', 'privy-id-token'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  credentials: false,
  maxAge: 86400,
}))

/* Routes */
app.get('/', (c) => {
  return c.text('Paystream API')
})


/* API Routes */
app.route('/api', apiRouter)

log.info(`Starting server on network: ${SOLANA_NETWORK}`)

// Initialize tip accounts cache
initializeTipAccounts().catch((error) => {
  log.error('Failed to initialize tip accounts:', error)
  process.exit(1)
})

// Initialize arb registry at startup (non-blocking)
initializeArbRegistry().catch((error) => {
  log.warn('Failed to initialize arb registry at startup:', error)
})

// Start HL spot → perp conversion poller
startHlConversionPoller()

// Start Telegram bot (non-blocking polling)
startBot().catch((error) => {
  log.warn('Failed to start Telegram bot:', error)
})

const server = Bun.serve({
  port: Bun.env.PORT || 9090,
  fetch(req, server) {
    // Handle WebSocket upgrade for price feed (avoid URL parse on every request)
    if (req.url.endsWith('/ws/prices')) {
      const ok = server.upgrade(req)
      return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
    }
    return app.fetch(req)
  },
  websocket: priceWebSocketHandler,
  idleTimeout: 120, // 2 minutes for slow endpoints like /arb/markets
})

log.info(`Server listening on port ${server.port}`)

// Start mark price feed (real-time prices to frontend via WS)
markPriceFeed = createMarkPriceFeed(server)
