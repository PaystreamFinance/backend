export const ARB_QUEUE_NAME = 'arb-position-monitoring'
export const ARB_PRODUCER_INTERVAL_MS = parseInt(
  process.env.ARB_PRODUCER_INTERVAL_MS || '15000',
  10
)
