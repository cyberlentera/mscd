// Run-time parts of the observability module (WP-34): the ARCHITECTURE 12 metrics on the registry of the process,
// the HTTP request metric and server spans (api and storage-gateway), the log ring buffer tap, and in-process
// OpenTelemetry tracing. No database access: the storage gateway loads this module too.
import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Span } from '@opentelemetry/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';
import type { Histogram } from 'prom-client';
import { MscdConfig } from '../../config/mscd-config';
import { MetricsService } from '../platform/metrics';
import { LOG_RING, tapPinoLogger } from './log-ring';
import { METRICS, SOURCE_METRICS, ensureCounter, ensureGauge, ensureHistogram, registerDerived } from './metric-catalogue';
import { preloadedSdk, startHttpTracer, type HttpTracer } from './telemetry';

/** Creates the metrics of the catalogue that need no database (the ops module adds the collected ones). */
@Injectable()
export class ObservabilityMetrics {
  readonly httpDuration: Histogram<'route' | 'method' | 'status'>;

  constructor(metrics: MetricsService) {
    const registry = metrics.registry;
    this.httpDuration = ensureHistogram(registry, METRICS.httpRequestDuration);
    // Updated by their owners (authorisation guard, audit.verify-chain); created here so the names are always listed.
    ensureCounter(registry, METRICS.authzDenied);
    ensureGauge(registry, METRICS.auditChainBroken);
    registerDerived(registry, METRICS.jobFailures, { name: SOURCE_METRICS.jobRuns, where: { outcome: 'failed' }, dropLabels: ['outcome'] });
    registerDerived(registry, METRICS.freshnessRecompute, { name: SOURCE_METRICS.jobDuration, where: { job: ['freshness.recompute', 'freshness.sweep'] } });
    registerDerived(registry, METRICS.gatewayRequestDuration, { name: SOURCE_METRICS.gatewayCallDuration });
    registerDerived(registry, METRICS.adapterThrottled, { name: SOURCE_METRICS.gatewayCalls, where: { outcome: 'rate-limited' }, dropLabels: ['outcome'] });
  }
}

/** In-process tracing when `telemetry.enabled` (see telemetry.ts); idle when a preloaded SDK traces the process. */
@Injectable()
export class TelemetryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Telemetry');
  private tracer: HttpTracer | null = null;

  constructor(private readonly config: MscdConfig) {}

  /** The HTTP tracer of this process, or null when tracing is off or preloaded. */
  get http(): HttpTracer | null {
    return this.tracer;
  }

  async onModuleInit(): Promise<void> {
    const { enabled, otlp_endpoint: endpoint } = this.config.profile.telemetry;
    if (!enabled || endpoint === null) return;
    if (preloadedSdk()) {
      this.logger.log('OpenTelemetry tracing runs through the preloaded SDK');
      return;
    }
    try {
      this.tracer = await startHttpTracer({ endpoint, runMode: this.config.runMode });
      this.logger.log(`OpenTelemetry tracing of HTTP requests to ${new URL(endpoint).origin}`);
    } catch (error) {
      this.logger.error(`OpenTelemetry tracing could not start and stays off: ${(error as Error).message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const tracer = this.tracer;
    this.tracer = null;
    try {
      await tracer?.shutdown();
      // The application owns the preloaded SDK's lifetime as well: shutting it down flushes the last spans.
      if (!tracer) await preloadedSdk()?.shutdown();
    } catch (error) {
      this.logger.warn(`OpenTelemetry shutdown: ${(error as Error).message}`);
    }
  }
}

const SPANS = new WeakMap<FastifyRequest, Span>();

/** Route pattern of a request (bounded label values), `unmatched` for 404s outside any route. */
export function routeLabel(request: FastifyRequest): string {
  return request.routeOptions?.url ?? 'unmatched';
}

/**
 * Fastify hooks of the HTTP run modes: `mscd_http_request_duration_seconds` by route pattern, method and status,
 * and a server span per request when in-process tracing is on. The worker has no HTTP adapter and is skipped.
 */
@Injectable()
export class HttpObservability implements OnModuleInit {
  constructor(
    private readonly metrics: ObservabilityMetrics,
    private readonly telemetry: TelemetryService,
    @Optional() private readonly adapterHost?: HttpAdapterHost,
  ) {}

  onModuleInit(): void {
    const adapter = this.adapterHost?.httpAdapter;
    if (!adapter || typeof adapter.getInstance !== 'function') return;
    const fastify = adapter.getInstance<FastifyInstance>();
    if (!fastify || typeof fastify.addHook !== 'function') return;
    fastify.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
      const tracer = this.telemetry.http;
      if (tracer) {
        SPANS.set(
          request,
          tracer.startServerSpan({ method: request.method, route: routeLabel(request), path: request.url, headers: request.headers, requestId: String(request.id) }),
        );
      }
      done();
    });
    fastify.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      this.metrics.httpDuration.observe(
        { route: routeLabel(request), method: request.method, status: String(reply.statusCode) },
        reply.elapsedTime / 1000,
      );
      const span = SPANS.get(request);
      if (span) {
        SPANS.delete(request);
        this.telemetry.http?.endServerSpan(span, reply.statusCode);
      }
      done();
    });
  }
}

/**
 * Copies the log lines of this process into the ring buffer of the diagnostics archive. Both pino loggers of
 * nestjs-pino are tapped: the request logger (its children write request lines) and the logger used outside a
 * request (application log lines).
 */
@Injectable()
export class LogRingTap implements OnApplicationBootstrap {
  private readonly logger = new Logger('LogRing');

  constructor(@Optional() private readonly pino?: PinoLogger) {}

  onApplicationBootstrap(): void {
    const root = PinoLogger.root as Parameters<typeof tapPinoLogger>[0];
    const outside = this.pino?.logger as Parameters<typeof tapPinoLogger>[0];
    const tapped = [tapPinoLogger(root, LOG_RING), tapPinoLogger(outside, LOG_RING)].filter(Boolean).length;
    if (tapped === 0) this.logger.warn('No log stream could be tapped: diagnostics archives carry no log lines');
  }
}
