export const SPOT_PERP_QUEUE_NAME = 'spot-perp-position-monitoring'
export const SPOT_PERP_PRODUCER_INTERVAL_MS = parseInt(
  process.env.SPOT_PERP_PRODUCER_INTERVAL_MS || '5000',
  10
)
