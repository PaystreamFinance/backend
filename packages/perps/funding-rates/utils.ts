import { log } from '../logger'

// --- Symbol canonicalization ---

const REAL_K_TOKENS = new Set(['KAS', 'KAVA', 'KMNO', 'KDA', 'KNC', 'KAIA'])

export function canonicalizeSymbol(upper: string): string {
  if (upper.startsWith('K') && upper.length > 1 && !REAL_K_TOKENS.has(upper)) {
    return '1000' + upper.slice(1)
  }
  return upper
}

// --- Concurrency limiter ---

export function pLimit(concurrency: number) {
  const queue: (() => void)[] = []
  let active = 0

  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++
      queue.shift()!()
    }
  }

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--
          next()
        })
      })
      next()
    })
}

// --- Retry with exponential backoff ---

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        log.warn(`[funding-rates] ${label} attempt ${attempt + 1} failed, retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  throw lastError
}

// --- Time helpers ---

export function floorToHour(date: Date): Date {
  const d = new Date(date)
  d.setMinutes(0, 0, 0)
  return d
}

/** Next hour boundary as epoch ms (e.g. 14:00:00.000 when called at 13:xx) */
export function nextHourMs(): number {
  return Math.ceil(Date.now() / 3_600_000) * 3_600_000
}

/** Next :30 boundary as epoch ms (e.g. 14:30 when called at 14:15, or 15:30 when called at 14:45) */
export function nextHalfHourMs(): number {
  const now = Date.now()
  const HOUR = 3_600_000
  const HALF = 1_800_000
  const hourStart = Math.floor(now / HOUR) * HOUR
  const halfMark = hourStart + HALF
  return now < halfMark ? halfMark : halfMark + HOUR
}

/** Advance a timestamp forward by intervalMs until it is in the future */
export function advanceToFuture(timestamp: number, intervalMs: number): number {
  const now = Date.now()
  let t = timestamp
  while (t <= now) t += intervalMs
  return t
}

export function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000)
}

export function daysAgo(days: number): Date {
  return hoursAgo(days * 24)
}

// --- Sleep ---

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
