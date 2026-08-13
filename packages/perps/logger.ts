const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
} as const

type LogArgs = Array<unknown>

function timestamp() {
  return `${COLORS.dim}${new Date().toISOString()}${COLORS.reset}`
}

export interface Logger {
  (message: unknown, ...rest: LogArgs): void
  info: (...args: LogArgs) => void
  warn: (...args: LogArgs) => void
  error: (...args: LogArgs) => void
  success: (...args: LogArgs) => void
}

const defaultLogger: Logger = Object.assign(
  (message: unknown, ...rest: LogArgs) => {
    console.log(`${timestamp()} ${COLORS.blue}[INFO]${COLORS.reset}`, message, ...rest)
  },
  {
    info: (...args: LogArgs) => {
      console.log(`${timestamp()} ${COLORS.blue}[INFO]${COLORS.reset}`, ...args)
    },
    warn: (...args: LogArgs) => {
      console.warn(`${timestamp()} ${COLORS.yellow}[WARN]${COLORS.reset}`, ...args)
    },
    error: (...args: LogArgs) => {
      console.error(`${timestamp()} ${COLORS.red}[ERROR]${COLORS.reset}`, ...args)
    },
    success: (...args: LogArgs) => {
      console.log(`${timestamp()} ${COLORS.green}[SUCCESS]${COLORS.reset}`, ...args)
    },
  },
)

let currentLogger: Logger = defaultLogger

/**
 * Get the current logger instance.
 * Defaults to console-based logging; override with setLogger() for OTel integration.
 */
export const log: Logger = Object.assign(
  (message: unknown, ...rest: LogArgs) => currentLogger(message, ...rest),
  {
    info: (...args: LogArgs) => currentLogger.info(...args),
    warn: (...args: LogArgs) => currentLogger.warn(...args),
    error: (...args: LogArgs) => currentLogger.error(...args),
    success: (...args: LogArgs) => currentLogger.success(...args),
  },
)

/**
 * Override the default logger with a custom implementation (e.g., OTel-based).
 * Call this early in your application startup.
 */
export function setLogger(logger: Logger): void {
  currentLogger = logger
}
