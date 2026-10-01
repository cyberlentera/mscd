// Preload entry of OpenTelemetry tracing with automatic instrumentation (see telemetry.ts):
//
//   NODE_OPTIONS="--require /app/dist/modules/observability/otel-preload.js" node /app/dist/main.js api
//
// It reads the same profile as the process (MSCD_PROFILE_FILE and MSCD__ overrides) and starts the SDK only when
// `telemetry.enabled` is true, synchronously, so the instrumentations are in place before the server loads its
// modules. Any problem is reported on stderr and the process starts without tracing: tracing never stops the
// service.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK, resources } from '@opentelemetry/sdk-node';
import { loadProfile } from '../../config/load-profile';
import { BUILD_FLAVOR, VERSION } from '../../generated/build-info';
import { REDACTED_QUERY_PARAMETERS } from '../platform/logging';
import { markPreloaded, pathOnly, preloadedSdk, serviceName, tracesUrl } from './telemetry';

const RUN_MODES = new Set(['api', 'worker', 'storage-gateway']);
const QUIET_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/** The run mode named on the command line (`main.js api`), or null for admin commands. */
export function runModeOf(argv: readonly string[]): string | null {
  const mode = argv.slice(2).find((arg) => !arg.startsWith('-'));
  return mode !== undefined && RUN_MODES.has(mode) ? mode : null;
}

/**
 * Starts the OpenTelemetry Node SDK with the automatic instrumentations. File system, DNS and net spans are left
 * out (noise, and file spans would name secret files); query values of the F.12 parameters are redacted.
 */
export function startPreloadSdk(options: { endpoint: string; runMode: string }): NodeSDK {
  const sdk = new NodeSDK({
    resource: resources.resourceFromAttributes({ 'service.name': serviceName(options.runMode), 'service.version': VERSION }),
    traceExporter: new OTLPTraceExporter({ url: tracesUrl(options.endpoint) }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          redactedQueryParams: [...REDACTED_QUERY_PARAMETERS, 'sig', 'signature', 'X-Amz-Signature', 'X-Amz-Credential'],
          redactedQueryParamsServer: [...REDACTED_QUERY_PARAMETERS],
          ignoreIncomingRequestHook: (request) => QUIET_PATHS.has(pathOnly(request.url ?? '/')),
        },
      }),
    ],
  });
  sdk.start();
  markPreloaded(sdk);
  return sdk;
}

function preload(): void {
  const runMode = runModeOf(process.argv);
  if (runMode === null || preloadedSdk()) return;
  const { profile } = loadProfile({ env: process.env, flavor: BUILD_FLAVOR });
  if (!profile.telemetry.enabled || profile.telemetry.otlp_endpoint === null) return;
  startPreloadSdk({ endpoint: profile.telemetry.otlp_endpoint, runMode });
}

try {
  preload();
} catch (error) {
  process.stderr.write(`mscd-server: OpenTelemetry preload skipped: ${error instanceof Error ? error.message : String(error)}\n`);
}
