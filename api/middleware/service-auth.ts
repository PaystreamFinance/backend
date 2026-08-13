import { timingSafeEqual } from 'node:crypto'
import type { Context, Next } from 'hono'

const MINIMUM_SERVICE_KEY_LENGTH = 32

export function validateServiceAuthConfig() {
  const configuredKey = Bun.env.INTERNAL_SERVICE_KEY
  if (!configuredKey || configuredKey.length < MINIMUM_SERVICE_KEY_LENGTH) {
    throw new Error(
      `INTERNAL_SERVICE_KEY must be configured with at least ${MINIMUM_SERVICE_KEY_LENGTH} characters`,
    )
  }
}

function isValidServiceKey(candidate: string | undefined): boolean {
  const configuredKey = Bun.env.INTERNAL_SERVICE_KEY
  if (
    !candidate ||
    !configuredKey ||
    configuredKey.length < MINIMUM_SERVICE_KEY_LENGTH
  ) {
    return false
  }

  const candidateBytes = Buffer.from(candidate)
  const configuredBytes = Buffer.from(configuredKey)
  return (
    candidateBytes.length === configuredBytes.length &&
    timingSafeEqual(candidateBytes, configuredBytes)
  )
}

export async function serviceAuthMiddleware(c: Context, next: Next) {
  if (!isValidServiceKey(c.req.header('x-service-key'))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401)
  }

  await next()
}
