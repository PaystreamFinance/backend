/**
 * OpenTelemetry Middleware for Hono
 *
 * This middleware creates spans for each incoming HTTP request,
 * capturing timing, status codes, and request metadata.
 */

import type { Context, Next } from 'hono'
import { trace, SpanKind, SpanStatusCode, context as otelContext } from '@opentelemetry/api'
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_PATH,
  ATTR_URL_FULL,
  ATTR_HTTP_ROUTE,
  ATTR_USER_AGENT_ORIGINAL,
  ATTR_CLIENT_ADDRESS,
} from '@opentelemetry/semantic-conventions'

const tracer = trace.getTracer('hono-server')

/**
 * Extract client IP from various headers
 */
function getClientIP(c: Context): string | undefined {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    c.req.header('cf-connecting-ip') || // Cloudflare
    undefined
  )
}

/**
 * OpenTelemetry middleware for Hono
 *
 * Creates a span for each request with:
 * - HTTP method, path, status code
 * - Request duration (automatic)
 * - User agent, client IP
 * - Error details if request fails
 */
export async function otelMiddleware(c: Context, next: Next) {
  const method = c.req.method
  const path = c.req.path
  const url = c.req.url

  // Create a span for this request
  return tracer.startActiveSpan(
    `${method} ${path}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: method,
        [ATTR_URL_PATH]: path,
        [ATTR_URL_FULL]: url,
        [ATTR_USER_AGENT_ORIGINAL]: c.req.header('user-agent'),
        [ATTR_CLIENT_ADDRESS]: getClientIP(c),
      },
    },
    async (span) => {
      // Store trace context in Hono context for use in handlers
      const traceId = span.spanContext().traceId
      const spanId = span.spanContext().spanId
      c.set('traceId', traceId)
      c.set('spanId', spanId)
      c.set('otelContext', otelContext.active())

      try {
        await next()

        // After handler execution, capture response details
        const status = c.res.status

        span.setAttributes({
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: status,
          [ATTR_HTTP_ROUTE]: c.req.routePath || path,
        })

        // Mark span as error if 5xx status
        if (status >= 500) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${status}`,
          })
        } else {
          span.setStatus({ code: SpanStatusCode.OK })
        }
      } catch (error) {
        // Capture exception details
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        })
        span.recordException(error instanceof Error ? error : new Error(String(error)))
        throw error
      } finally {
        span.end()
      }
    },
  )
}

/**
 * Create a child span for custom operations within a handler
 *
 * Usage:
 * ```ts
 * await withSpan(c, 'fetch-user-data', async (span) => {
 *   span.setAttribute('user.id', userId)
 *   return await fetchUser(userId)
 * })
 * ```
 */
export async function withSpan<T>(
  c: Context,
  name: string,
  fn: (span: ReturnType<typeof tracer.startSpan>) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const parentContext = c.get('otelContext') || otelContext.active()

  return otelContext.with(parentContext, async () => {
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await fn(span)
        span.setStatus({ code: SpanStatusCode.OK })
        return result
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        })
        span.recordException(error instanceof Error ? error : new Error(String(error)))
        throw error
      } finally {
        span.end()
      }
    })
  })
}

// Extend Hono's Context type to include our custom properties
declare module 'hono' {
  interface ContextVariableMap {
    traceId: string
    spanId: string
    otelContext: ReturnType<typeof otelContext.active>
  }
}
