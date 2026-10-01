// The ops and observability modules in the run modes as the CLI builds them (D.4): the full api application
// mounts the operations routes behind real sessions and lists every metric; the worker application context (no
// HTTP adapter) resolves the collectors and the catalogue as well.
import { Test } from '@nestjs/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiModule } from '../../../src/app/api.module';
import { WorkerModule } from '../../../src/app/worker.module';
import { ARCHITECTURE_METRIC_NAMES } from '../../../src/modules/observability/metric-catalogue';
import { TelemetryService } from '../../../src/modules/observability/observability.service';
import { OpsMetricsCollector } from '../../../src/modules/ops/ops-metrics.collector';
import { createHttpApplication } from '../../../src/modules/platform/http-app';
import { MetricsService } from '../../../src/modules/platform/metrics';
import { useTestDatabase } from '../../setup/test-db';

describe('ops and observability in the api and worker run modes', () => {
  const db = useTestDatabase('empty');
  const closers: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const close of closers.reverse()) await close();
  });

  it('api: the operations routes need a session and every catalogue metric is registered', async () => {
    const config = db.config();
    const app = await createHttpApplication(ApiModule.forRoot(config), config);
    closers.push(() => app.close());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    for (const url of ['/api/v1/ops/health', '/api/v1/ops/queues']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/ops/diagnostics' })).statusCode).toBe(401);
    const text = await app.get(MetricsService).registry.metrics();
    for (const name of ARCHITECTURE_METRIC_NAMES) expect(text, name).toContain(`# TYPE ${name} `);
    const line = text.split('\n').find((l) => l.startsWith('mscd_http_request_duration_seconds_count{') && l.includes('route="/api/v1/ops/health"') && l.includes('status="401"'));
    expect(line).toMatch(/ 1$/);
    expect(line).toContain('mode="api"');
  });

  it('worker: the collectors resolve without an HTTP adapter', async () => {
    const config = db.config({}, 'worker');
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] }).compile();
    const context = await moduleRef.init();
    closers.push(() => context.close());
    const collector = context.get(OpsMetricsCollector);
    const snapshot = await collector.refresh();
    expect(snapshot.outbox.stuckRows).toBe(0);
    expect(context.get(TelemetryService).http).toBeNull();
    const text = await context.get(MetricsService).registry.metrics();
    for (const name of ARCHITECTURE_METRIC_NAMES) expect(text, name).toContain(`# TYPE ${name} `);
    expect(text).toContain('mscd_mfa_locks_total{mode="worker"} 0');
  });
});
