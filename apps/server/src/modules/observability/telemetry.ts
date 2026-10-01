// OpenTelemetry tracing (ARCHITECTURE 12, build plan A.1 and WP-34). Off by default; with `telemetry.enabled: true`
// spans are exported over OTLP/HTTP to `telemetry.otlp_endpoint` (the customer's collector). On-premise nothing is
// sent anywhere else.
//
// Two ways to start it:
//   - in process (default): `TelemetryService` starts a tracer provider when the application starts and records one
//     server span per HTTP request (route pattern, method, status; never the query string, F.12), continuing a W3C
//     `traceparent` sent by the caller;
//   - preloaded: `node --require <dist>/modules/observability/otel-preload.js <dist>/main.js <mode>` starts the
//     OpenTelemetry Node SDK with the automatic instrumentations (HTTP, PostgreSQL, Valkey, undici) before any
//     module is loaded, which in-process start-up cannot do. The service then leaves tracing to the preloaded SDK
//     and only shuts it down with the application.
// The OpenTelemetry packages are loaded only when tracing is enabled.
import type { Span, Tracer, TextMapGetter } from '@opentelemetry/api';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import { VERSION } from '../../generated/build-info';

/** Global marker of a preloaded SDK (shared by the preload script and the application, which may be two bundles). */
const PRELOADED = Symbol.for('mscd.otel.preloadedSdk');

type GlobalWithSdk = typeof globalThis & { [PRELOADED]?: NodeSDK };

/** The SDK started by `otel-preload`, if any. */
export function preloadedSdk(): NodeSDK | undefined {
  return (globalThis as GlobalWithSdk)[PRELOADED];
}

export function markPreloaded(sdk: NodeSDK): void {
  (globalThis as GlobalWithSdk)[PRELOADED] = sdk;
}

/** The OTLP/HTTP traces URL of an endpoint: `<endpoint>/v1/traces` unless the endpoint already names it. */
export function tracesUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}

/** `service.name` of a run mode. */
export function serviceName(runMode: string): string {
  return `mscd-${runMode}`;
}

/** Strips the query string and fragment: span attributes never carry query values (F.12). */
export function pathOnly(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}

export interface HttpSpanStart {
  method: string;
  /** Route pattern (`/api/v1/ops/jobs/:name/run`), or `unmatched`. */
  route: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

/** A tracer of this process with a W3C trace context reader for incoming requests. */
export interface HttpTracer {
  startServerSpan(start: HttpSpanStart): Span;
  endServerSpan(span: Span, statusCode: number): void;
  shutdown(): Promise<void>;
}

const headerGetter: TextMapGetter<Record<string, string | string[] | undefined>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key.toLowerCase()],
};

/** Starts an in-process tracer provider exporting to `endpoint` (no global registration, no instrumentations). */
export async function startHttpTracer(options: { endpoint: string; runMode: string }): Promise<HttpTracer> {
  const otel = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const { api, core, resources, tracing } = otel;
  const provider = new tracing.BasicTracerProvider({
    resource: resources.resourceFromAttributes({ 'service.name': serviceName(options.runMode), 'service.version': VERSION }),
    spanProcessors: [new tracing.BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl(options.endpoint) }))],
  });
  const tracer: Tracer = provider.getTracer('mscd-server', VERSION);
  const propagator = new core.W3CTraceContextPropagator();
  return {
    startServerSpan(start: HttpSpanStart): Span {
      const parent = propagator.extract(api.ROOT_CONTEXT, start.headers, headerGetter);
      return tracer.startSpan(
        `${start.method} ${start.route}`,
        {
          kind: api.SpanKind.SERVER,
          attributes: {
            'http.request.method': start.method,
            'http.route': start.route,
            'url.path': pathOnly(start.path),
            ...(start.requestId ? { 'mscd.request_id': start.requestId } : {}),
          },
        },
        parent,
      );
    },
    endServerSpan(span: Span, statusCode: number): void {
      span.setAttribute('http.response.status_code', statusCode);
      if (statusCode >= 500) span.setStatus({ code: api.SpanStatusCode.ERROR });
      span.end();
    },
    async shutdown(): Promise<void> {
      await provider.shutdown();
    },
  };
}
