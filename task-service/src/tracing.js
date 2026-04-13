const { NodeSDK } = require("@opentelemetry/sdk-node");
const {
  getNodeAutoInstrumentations,
} = require("@opentelemetry/auto-instrumentations-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-http");
const {
  OTLPMetricExporter,
} = require("@opentelemetry/exporter-metrics-otlp-http");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
const { Resource } = require("@opentelemetry/resources");
const {
  SemanticResourceAttributes,
} = require("@opentelemetry/semantic-conventions");

const serviceName = process.env.OTEL_SERVICE_NAME || "task-service";
const otlpBaseUrl =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
const traceEndpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || `${otlpBaseUrl}/v1/traces`;
const metricEndpoint =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
  `${otlpBaseUrl}/v1/metrics`;

process.env.OTEL_SERVICE_NAME = serviceName;

const metricReader = new PeriodicExportingMetricReader({
  exporter: new OTLPMetricExporter({ url: metricEndpoint }),
  exportIntervalMillis:
    Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS) || 10000,
});

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  }),
  traceExporter: new OTLPTraceExporter({ url: traceEndpoint }),
  metricReader,
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": { enabled: true },
      "@opentelemetry/instrumentation-express": { enabled: true },
      "@opentelemetry/instrumentation-pg": { enabled: true },
    }),
  ],
});

const maybePromise = sdk.start();
if (maybePromise && typeof maybePromise.catch === "function") {
  maybePromise.catch((err) => {
    // eslint-disable-next-line no-console
    console.error("OpenTelemetry SDK start error", err);
  });
}

const shutdown = () => {
  console.log("Shutting down OpenTelemetry SDK...");

  sdk
    .shutdown()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("OpenTelemetry SDK shutdown error", err);
    })
    .finally(() => {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
      process.exit(0);
    });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
