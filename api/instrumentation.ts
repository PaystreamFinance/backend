/**
 * OpenTelemetry Instrumentation Setup
 *
 * This file MUST be imported before any other imports in main.ts
 * to ensure all modules are properly instrumented.
 *
 * Set OTEL_EXPORTER_OTLP_ENDPOINT to enable (e.g., http://localhost:4318).
 * When unset, OTel is disabled and logs go to console only.
 */

const otlpEndpoint = Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT

if (otlpEndpoint) {
  const { NodeSDK } = await import('@opentelemetry/sdk-node')
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
  const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http')
  const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http')
  const { resourceFromAttributes } = await import('@opentelemetry/resources')
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import('@opentelemetry/semantic-conventions')
  const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics')
  const { BatchLogRecordProcessor } = await import('@opentelemetry/sdk-logs')
  const { diag, DiagConsoleLogger, DiagLogLevel } = await import('@opentelemetry/api')

  const logLevel = Bun.env.OTEL_DEBUG === 'true' ? DiagLogLevel.DEBUG : DiagLogLevel.NONE
  diag.setLogger(new DiagConsoleLogger(), logLevel)

  const serviceName = Bun.env.OTEL_SERVICE_NAME || 'api'
  const serviceVersion = Bun.env.OTEL_SERVICE_VERSION || '1.0.0'
  const environment = Bun.env.NODE_ENV || 'development'

  const signozHeaders: Record<string, string> = {}
  if (Bun.env.SIGNOZ_INGESTION_KEY) {
    signozHeaders['signoz-ingestion-key'] = Bun.env.SIGNOZ_INGESTION_KEY
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    'deployment.environment': environment,
  })

  const traceExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
    headers: signozHeaders,
    timeoutMillis: 30000,
  })

  const metricExporter = new OTLPMetricExporter({
    url: `${otlpEndpoint}/v1/metrics`,
    headers: signozHeaders,
    timeoutMillis: 30000,
  })

  const logExporter = new OTLPLogExporter({
    url: `${otlpEndpoint}/v1/logs`,
    headers: signozHeaders,
    timeoutMillis: 30000,
  })

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60000,
    }),
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: logExporter })],
    instrumentations: [],
  })

  sdk.start()

  const shutdown = async () => {
    try {
      await sdk.shutdown()
      console.log('OpenTelemetry SDK shut down successfully')
    } catch (error) {
      console.error('Error shutting down OpenTelemetry SDK:', error)
    }
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  console.log(`OpenTelemetry initialized — exporting to ${otlpEndpoint}`)
} else {
  console.log('OTEL_EXPORTER_OTLP_ENDPOINT not set — SigNoz disabled')
}
