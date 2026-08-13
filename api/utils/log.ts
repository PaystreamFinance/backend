import { trace, context } from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
} as const

type LogArgs = Array<unknown>

// Get the OTel logger for sending logs to SigNoz
const otelLogger = logs.getLogger('api')

function timestamp() {
  const now = new Date()
  return `${COLORS.dim}${now.toISOString()}${COLORS.reset}`
}

/**
 * Get current trace context for log correlation
 */
function getTraceContext(): { traceId?: string; spanId?: string } {
  const activeSpan = trace.getSpan(context.active())
  if (activeSpan) {
    const spanContext = activeSpan.spanContext()
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
    }
  }
  return {}
}

function format(level: string, color: string) {
  const { traceId } = getTraceContext()
  const traceInfo = traceId ? ` ${COLORS.cyan}[${traceId.slice(0, 8)}]${COLORS.reset}` : ''
  return `${timestamp()} ${color}[${level}]${COLORS.reset}${traceInfo}`
}

/**
 * Emit a log record to OpenTelemetry (for SigNoz)
 */
function emitOtelLog(
  severityNumber: SeverityNumber,
  severityText: string,
  message: string,
  attributes?: Record<string, unknown>,
) {
  const { traceId, spanId } = getTraceContext()

  otelLogger.emit({
    severityNumber,
    severityText,
    body: message,
    attributes: {
      ...attributes,
      // These allow SigNoz to correlate logs with traces
      ...(traceId && { trace_id: traceId }),
      ...(spanId && { span_id: spanId }),
    },
  })
}

/**
 * Format log arguments into a string
 */
function formatArgs(args: LogArgs): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.message}\n${arg.stack}`
      }
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      }
      return String(arg)
    })
    .join(' ')
}

export const log = Object.assign(
  (message: unknown, ...rest: LogArgs) => {
    console.log(`${format('INFO', COLORS.blue)}`, message, ...rest)
    emitOtelLog(SeverityNumber.INFO, 'INFO', formatArgs([message, ...rest]))
  },
  {
    info: (...args: LogArgs) => {
      console.log(`${format('INFO', COLORS.blue)}`, ...args)
      emitOtelLog(SeverityNumber.INFO, 'INFO', formatArgs(args))
    },
    warn: (...args: LogArgs) => {
      console.warn(`${format('WARN', COLORS.yellow)}`, ...args)
      emitOtelLog(SeverityNumber.WARN, 'WARN', formatArgs(args))
    },
    error: (...args: LogArgs) => {
      console.error(`${format('ERROR', COLORS.red)}`, ...args)

      // Extract error details if present
      const errorArg = args.find((arg) => arg instanceof Error) as Error | undefined
      emitOtelLog(SeverityNumber.ERROR, 'ERROR', formatArgs(args), {
        ...(errorArg && {
          'error.type': errorArg.name,
          'error.message': errorArg.message,
          'error.stack': errorArg.stack,
        }),
      })
    },
    success: (...args: LogArgs) => {
      console.log(`${format('SUCCESS', COLORS.green)}`, ...args)
      emitOtelLog(SeverityNumber.INFO, 'SUCCESS', formatArgs(args))
    },
    /**
     * Log with custom attributes (useful for structured logging)
     *
     * Usage:
     * ```ts
     * log.with({ userId: '123', action: 'swap' }).info('User performed swap')
     * ```
     */
    with: (attributes: Record<string, unknown>) => ({
      info: (...args: LogArgs) => {
        console.log(`${format('INFO', COLORS.blue)}`, ...args)
        emitOtelLog(SeverityNumber.INFO, 'INFO', formatArgs(args), attributes)
      },
      warn: (...args: LogArgs) => {
        console.warn(`${format('WARN', COLORS.yellow)}`, ...args)
        emitOtelLog(SeverityNumber.WARN, 'WARN', formatArgs(args), attributes)
      },
      error: (...args: LogArgs) => {
        console.error(`${format('ERROR', COLORS.red)}`, ...args)
        const errorArg = args.find((arg) => arg instanceof Error) as Error | undefined
        emitOtelLog(SeverityNumber.ERROR, 'ERROR', formatArgs(args), {
          ...attributes,
          ...(errorArg && {
            'error.type': errorArg.name,
            'error.message': errorArg.message,
            'error.stack': errorArg.stack,
          }),
        })
      },
    }),
  },
)

export type LogFunction = typeof log
