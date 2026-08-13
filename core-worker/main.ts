// IMPORTANT: Import instrumentation FIRST before any other imports
// This ensures all modules are properly instrumented by OpenTelemetry
import './instrumentation'

import { startArbProducer } from "./queue/arb-producer";
import { startArbWorker } from "./queue/arb-worker";
import { ARB_PRODUCER_INTERVAL_MS } from "./queue/arb-config";
import { startSpotPerpProducer } from "./queue/spot-perp-producer";
import { startSpotPerpWorker } from "./queue/spot-perp-worker";
import { SPOT_PERP_PRODUCER_INTERVAL_MS } from "./queue/spot-perp-config";
import { waitForRedis } from "./queue/config";
import { log } from "./utils/log";
import { setLogger } from '@paystream/perps/logger';
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'
import { startFundingRatesScheduler, getConfiguredInterval as getFundingRatesInterval } from "./funding-rates";
import { startOpportunityChecker, getConfiguredInterval as getOpportunityCheckerInterval } from "./services/opportunity-checker";
import { oiMonitor } from "./services/oi-monitor";

// Inject OTel logger into @paystream/perps so shared code uses structured logging
setLogger(log)

/**
 * WORKER_ENV controls which services run.
 *   "production" (default) — all services
 *   anything else           — only services listed in ENABLED_SERVICES (comma-separated)
 *
 * Available service names:
 *   funding-rates, arb, spot-perp, opportunity-checker
 *
 * Examples:
 *   WORKER_ENV=local ENABLED_SERVICES=arb                  — only arb monitoring
 *   WORKER_ENV=local ENABLED_SERVICES=arb,spot-perp        — arb + spot-perp
 *   WORKER_ENV=local ENABLED_SERVICES=funding-rates        — only funding rates
 *   WORKER_ENV=production                                  — everything
 */
const WORKER_ENV = process.env.WORKER_ENV || "production";
const ENABLED_SERVICES = new Set(
  (process.env.ENABLED_SERVICES || "").split(",").map(s => s.trim()).filter(Boolean)
);

function isEnabled(service: string): boolean {
  if (WORKER_ENV === "production") return true;
  return ENABLED_SERVICES.has(service);
}

async function main() {
  try {
    await waitForRedis();
  } catch (error) {
    log.error("Failed to connect to Redis:", error);
    process.exit(1);
  }

  if (WORKER_ENV !== "production") {
    log.info(`[config] WORKER_ENV=${WORKER_ENV}, enabled services: ${[...ENABLED_SERVICES].join(", ") || "(none)"}`);
  } else {
    log.info(`[config] WORKER_ENV=production — all services enabled`);
  }

  // Funding rates scheduler
  if (isEnabled("funding-rates")) {
    const fundingRatesInterval = getFundingRatesInterval();
    log.info(`Starting funding rates scheduler (interval: ${fundingRatesInterval / 1000 / 60} minutes)...`);
    startFundingRatesScheduler(fundingRatesInterval);
  }

  // Better opportunity checker (hourly notifications)
  if (isEnabled("opportunity-checker")) {
    const opportunityInterval = getOpportunityCheckerInterval();
    log.info(`Starting opportunity checker (interval: ${opportunityInterval / 1000 / 60} minutes)...`);
    startOpportunityChecker(opportunityInterval);
  }

  // Arb position monitoring
  if (isEnabled("arb")) {
    await oiMonitor.start()
    startArbWorker();
    await new Promise((resolve) => setTimeout(resolve, 500));
    log.info(`Starting arb producer (interval: ${ARB_PRODUCER_INTERVAL_MS}ms)`);
    await startArbProducer(ARB_PRODUCER_INTERVAL_MS);
  }

  // Spot-perp position monitoring
  if (isEnabled("spot-perp")) {
    startSpotPerpWorker();
    await new Promise((resolve) => setTimeout(resolve, 500));
    log.info(`Starting spot-perp producer (interval: ${SPOT_PERP_PRODUCER_INTERVAL_MS}ms)`);
    await startSpotPerpProducer(SPOT_PERP_PRODUCER_INTERVAL_MS);
  }

}

// Prevent unhandled errors from crashing the worker
process.on('unhandledRejection', (reason) => {
  log.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason)
  sendOpsAlert({
    key: 'core-worker-unhandled-rejection',
    severity: AlertSeverity.CRITICAL,
    title: 'Unhandled rejection in core-worker',
    message: reason instanceof Error ? reason.message : String(reason),
    service: 'core-worker',
    error: reason,
  })
})
process.on('uncaughtException', (error) => {
  log.error('[uncaughtException]', error.message)
  sendOpsAlert({
    key: 'core-worker-uncaught-exception',
    severity: AlertSeverity.CRITICAL,
    title: 'Uncaught exception in core-worker',
    message: error.message,
    service: 'core-worker',
    error,
  })
})

// Clean shutdown
let shutdownInProgress = false
function shutdown(signal: string) {
  if (shutdownInProgress) {
    log.warn(`[shutdown] Forced exit (${signal})`)
    process.exit(1)
  }
  shutdownInProgress = true
  log.info(`[shutdown] ${signal} received, exiting...`)
  oiMonitor.stop()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

main().catch((error) => {
  log.error("Fatal error:", error);
  process.exit(1);
});
