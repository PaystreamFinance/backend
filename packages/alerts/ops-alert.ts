import { AlertSeverity, type OpsAlertOptions } from './types'

// Throttle windows per severity
const THROTTLE_MS: Record<AlertSeverity, number> = {
  [AlertSeverity.CRITICAL]: 5 * 60 * 1000,   // 5 minutes
  [AlertSeverity.WARNING]: 15 * 60 * 1000,    // 15 minutes
  [AlertSeverity.INFO]: 60 * 60 * 1000,       // 60 minutes
}

// Severity emoji for Telegram
const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  [AlertSeverity.CRITICAL]: '🚨',
  [AlertSeverity.WARNING]: '⚠️',
  [AlertSeverity.INFO]: 'ℹ️',
}

// In-memory throttle state
interface ThrottleEntry {
  lastSentAt: number
  suppressedCount: number
}
const throttleMap = new Map<string, ThrottleEntry>()

// Evict stale entries every 10 minutes to prevent unbounded growth from dynamic keys
const EVICT_INTERVAL_MS = 10 * 60 * 1000
const MAX_THROTTLE_AGE_MS = 60 * 60 * 1000 // 1 hour (longest throttle window)
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of throttleMap) {
    if (now - entry.lastSentAt > MAX_THROTTLE_AGE_MS) {
      throttleMap.delete(key)
    }
  }
}, EVICT_INTERVAL_MS).unref()

// Lazy-init state
let initialized = false
let telegramToken: string | undefined
let telegramChatId: string | undefined
let betterstackApiKey: string | undefined
let betterstackRequesterEmail: string | undefined

function init() {
  if (initialized) return
  initialized = true

  telegramToken = process.env.OPS_TELEGRAM_BOT_TOKEN
  telegramChatId = process.env.OPS_TELEGRAM_CHAT_ID
  betterstackApiKey = process.env.BETTERSTACK_API_KEY
  betterstackRequesterEmail = process.env.BETTERSTACK_REQUESTER_EMAIL

  if (!telegramToken || !telegramChatId) {
    console.warn('[ops-alert] OPS_TELEGRAM_BOT_TOKEN or OPS_TELEGRAM_CHAT_ID not set — ops alerts disabled')
  }
}

/**
 * Check throttle — returns true if the alert should be sent, false if suppressed.
 * When sent, includes suppressed count from the window.
 */
function checkThrottle(key: string, severity: AlertSeverity): { send: boolean; suppressedCount: number } {
  const now = Date.now()
  const window = THROTTLE_MS[severity]
  const entry = throttleMap.get(key)

  if (!entry || now - entry.lastSentAt >= window) {
    const suppressed = entry?.suppressedCount ?? 0
    throttleMap.set(key, { lastSentAt: now, suppressedCount: 0 })
    return { send: true, suppressedCount: suppressed }
  }

  entry.suppressedCount++
  return { send: false, suppressedCount: entry.suppressedCount }
}

function formatTelegramMessage(opts: OpsAlertOptions, suppressedCount: number): string {
  const emoji = SEVERITY_EMOJI[opts.severity]
  const service = opts.service ? ` [${opts.service}]` : ''
  const suppressed = suppressedCount > 0 ? `\n<i>(+${suppressedCount} suppressed)</i>` : ''

  let errorInfo = ''
  if (opts.error) {
    const err = opts.error instanceof Error ? opts.error : new Error(String(opts.error))
    const stack = err.stack?.slice(0, 500) || ''
    if (stack) {
      errorInfo = `\n<pre>${escapeHtml(stack)}</pre>`
    }
  }

  return [
    `${emoji} <b>${opts.severity}${service}</b>`,
    `<b>${escapeHtml(opts.title)}</b>`,
    escapeHtml(opts.message),
    errorInfo,
    suppressed,
  ].filter(Boolean).join('\n')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function sendTelegram(message: string): Promise<void> {
  if (!telegramToken || !telegramChatId) return

  await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  })
}

async function sendBetterstack(opts: OpsAlertOptions): Promise<void> {
  if (!betterstackApiKey) return

  await fetch('https://uptime.betterstack.com/api/v2/incidents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${betterstackApiKey}`,
    },
    body: JSON.stringify({
      requester_email: betterstackRequesterEmail || 'ops@paystream.finance',
      name: `[${opts.severity}] ${opts.title}`,
      summary: opts.message,
      call: true,
      sms: true,
      email: true,
    }),
  })
}

/**
 * Send an ops alert to Telegram (and BetterStack for CRITICAL).
 * Fire-and-forget — never throws, never blocks.
 */
export function sendOpsAlert(opts: OpsAlertOptions): void {
  init()

  const { send, suppressedCount } = checkThrottle(opts.key, opts.severity)
  if (!send) return

  const message = formatTelegramMessage(opts, suppressedCount)

  // Fire-and-forget: send Telegram
  sendTelegram(message).catch(() => {})

  // CRITICAL alerts also go to BetterStack for phone call escalation
  if (opts.severity === AlertSeverity.CRITICAL) {
    sendBetterstack(opts).catch(() => {})
  }
}
