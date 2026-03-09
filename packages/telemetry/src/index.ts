/**
 * @nexusops/telemetry — OpenTelemetry Distributed Tracing & Metrics
 *
 * Initializes the OpenTelemetry SDK with:
 * - OTLP HTTP trace exporter (Jaeger/Tempo/Grafana compatible)
 * - OTLP HTTP metrics exporter (Prometheus/Grafana compatible)
 * - Auto-instrumentation for HTTP and Fastify
 * - Custom span helpers for policy evaluation, DB queries, proxy calls
 *
 * MUST be imported before any other module in the service entrypoint.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import {
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

import { createLogger } from '@nexusops/logger';

const logger = createLogger('telemetry');

// ─── Configuration ───────────────────────────

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'nexusops-api';
const SERVICE_VERSION = process.env.npm_package_version || '0.1.0';
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const OTEL_ENABLED = process.env.OTEL_ENABLED !== 'false';
const NODE_ENV = process.env.NODE_ENV || 'development';

// ─── SDK Initialization ──────────────────────

let sdk: NodeSDK | null = null;

export function initTelemetry(serviceName?: string): void {
  if (!OTEL_ENABLED) {
    logger.info('OpenTelemetry disabled (OTEL_ENABLED=false)');
    return;
  }

  const resolvedName = serviceName || SERVICE_NAME;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: resolvedName,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    'deployment.environment.name': NODE_ENV,
  });

  const traceExporter = new OTLPTraceExporter({
    url: `${OTEL_ENDPOINT}/v1/traces`,
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
      ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS)
      : undefined,
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${OTEL_ENDPOINT}/v1/metrics`,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 30_000, // Export metrics every 30s
  });

  sdk = new NodeSDK({
    resource,
    spanProcessor: new BatchSpanProcessor(traceExporter, {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
    }),
    metricReader,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const url = req.url ?? '';
          return url === '/health' || url === '/ready';
        },
      }),
      new FastifyInstrumentation(),
    ],
  });

  sdk.start();
  logger.info({ service: resolvedName, endpoint: OTEL_ENDPOINT }, 'OpenTelemetry SDK initialized');

  // Graceful shutdown
  const shutdown = async () => {
    try {
      await sdk?.shutdown();
      logger.info('OpenTelemetry SDK shut down');
    } catch (err) {
      logger.error({ err }, 'Error shutting down OpenTelemetry SDK');
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ─── Tracer Accessors ────────────────────────

export function getTracer(name?: string): Tracer {
  return trace.getTracer(name || SERVICE_NAME, SERVICE_VERSION);
}

// ─── Custom Span Helpers ─────────────────────

/**
 * Wrap an async function in a traced span.
 * Automatically records errors and sets status.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: {
    kind?: SpanKind;
    attributes?: Record<string, string | number | boolean>;
  },
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    name,
    { kind: options?.kind ?? SpanKind.INTERNAL },
    async (span) => {
      if (options?.attributes) {
        for (const [key, value] of Object.entries(options.attributes)) {
          span.setAttribute(key, value);
        }
      }

      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Trace a policy evaluation call.
 */
export async function tracePolicyEvaluation<T>(
  workspaceId: string,
  agentId: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan('policy.evaluate', fn, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'nexusops.workspace_id': workspaceId,
      'nexusops.agent_id': agentId,
      'nexusops.component': 'policy-engine',
    },
  });
}

/**
 * Trace a database operation.
 */
export async function traceDbOperation<T>(
  operation: string,
  model: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`db.${operation}`, fn, {
    kind: SpanKind.CLIENT,
    attributes: {
      'db.system': 'postgresql',
      'db.operation': operation,
      'db.collection.name': model,
    },
  });
}

/**
 * Trace an outbound proxy/tool call.
 */
export async function traceProxyCall<T>(
  toolType: string,
  method: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`proxy.${toolType}.${method}`, fn, {
    kind: SpanKind.CLIENT,
    attributes: {
      'nexusops.tool_type': toolType,
      'nexusops.tool_method': method,
      'nexusops.component': 'proxy',
    },
  });
}

/**
 * Trace cryptographic operations (signing, hashing, chain verification).
 */
export async function traceCryptoOperation<T>(
  operation: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`crypto.${operation}`, fn, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'nexusops.component': 'crypto',
      'nexusops.crypto_operation': operation,
    },
  });
}

// Re-export OpenTelemetry API for advanced usage
export { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
export type { Span, Tracer } from '@opentelemetry/api';
