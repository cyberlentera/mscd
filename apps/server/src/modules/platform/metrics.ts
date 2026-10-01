import { createServer, type Server, type ServerResponse } from 'node:http';
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { collectDefaultMetrics, Registry } from 'prom-client';
import { MscdConfig } from '../../config/mscd-config';
import { ReadinessService } from './readiness.service';

/** The Prometheus registry of this process, with the default Node metrics. Modules add their metrics here. */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  constructor(config: MscdConfig) {
    this.registry.setDefaultLabels({ mode: config.runMode });
    collectDefaultMetrics({ register: this.registry });
  }
}

/**
 * Separate listener on `observability.metrics_port` (9464, never exposed by the ingress, D.3): `GET /metrics`
 * in Prometheus text format, plus `GET /healthz` and `GET /readyz` for run modes without an HTTP API (worker).
 * A port that cannot be bound is logged as an error and the process keeps running without metrics.
 */
@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MetricsServer.name);
  private server?: Server;

  constructor(
    private readonly config: MscdConfig,
    private readonly metrics: MetricsService,
    private readonly readiness: ReadinessService,
  ) {}

  /** Bound port once listening (useful when the profile asks for an ephemeral port in tests). */
  get port(): number | undefined {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null ? address.port : undefined;
  }

  async onApplicationBootstrap(): Promise<void> {
    const port = this.config.profile.observability.metrics_port;
    if (port === null) return;
    const server = createServer((req, res) => {
      void this.handle(req.method ?? 'GET', (req.url ?? '/').split('?')[0]!, res);
    });
    await new Promise<void>((resolve) => {
      server.once('error', (error) => {
        this.logger.error(`Metrics listener could not bind port ${port}: ${error.message}; metrics are not served`);
        resolve();
      });
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        resolve();
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(method: string, path: string, res: ServerResponse): Promise<void> {
    try {
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end();
      } else if (path === '/metrics') {
        const body = await this.metrics.registry.metrics();
        res.writeHead(200, { 'content-type': this.metrics.registry.contentType, 'cache-control': 'no-store' }).end(body);
      } else if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"status":"ok"}');
      } else if (path === '/readyz') {
        const report = await this.readiness.evaluate();
        res
          .writeHead(report.status === 'ready' ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(JSON.stringify(report));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"status":"not_found"}');
      }
    } catch (error) {
      this.logger.error(`Metrics listener failed on ${path}: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }
}
