export enum AlertSeverity {
  CRITICAL = 'CRITICAL',
  WARNING = 'WARNING',
  INFO = 'INFO',
}

export interface OpsAlertOptions {
  /** Deduplication key — alerts with the same key are throttled together */
  key: string
  /** Alert severity level */
  severity: AlertSeverity
  /** Human-readable alert title */
  title: string
  /** Detail message */
  message: string
  /** Which service originated the alert */
  service?: 'api' | 'core-worker'
  /** Error object for stack trace inclusion */
  error?: Error | unknown
}
