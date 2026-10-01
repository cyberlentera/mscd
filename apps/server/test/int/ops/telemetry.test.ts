// OpenTelemetry tracing (WP-34): with `telemetry.enabled` and an OTLP endpoint, every HTTP request becomes a server
// span exported over OTLP/HTTP to the configured collector, continuing the caller's W3C trace and never carrying
// query values; with telemetry off nothing is sent.
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelemetryService } from '../../../src/modules/observability/observability.service';
import { pathOnly, tracesUrl } from '../../../src/modules/observability/telemetry';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addUser } from '../db/helpers';
import { infoOf } from '../platform/helpers';
import { as, createOpsApp, opsIdentities } from './helpers';

interface Received {
  url: string;
  contentType: string | undefined;
  body: string;
}

describe('OpenTelemetry tracing (WP-34)', () => {
  const db = useTestDatabase('empty');
  let collector: Server;
  let collectorPort: number;
  const received: Received[] = [];
  let identities: ReturnType<typeof opsIdentities>;

  beforeAll(async () => {
    collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', () => resolve()));
    const address = collector.address();
    collectorPort = typeof address === 'object' && address !== null ? address.port : 0;
    const tenant = await createTenant(db, 'tel');
    const operator = await addUser(db.migrator, 'ops.tel', []);
    const admin = await addUser(db.migrator, 'ta.tel', [tenant.id]);
    identities = opsIdentities({ id: operator, handle: 'ops.tel' }, { id: admin, handle: 'ta.tel', org: infoOf(tenant) });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });

  it('exports one server span per request with the route, the status and the caller trace, without query values', async () => {
    const ctx = await createOpsApp(db, identities, {
      env: { MSCD__TELEMETRY__ENABLED: 'true', MSCD__TELEMETRY__OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}` },
    });
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    try {
      expect(ctx.moduleRef.get(TelemetryService).http).not.toBeNull();
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/ops/queues?token=tok-SECRET-55aa66bb',
        headers: { ...as('ops'), traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
      });
      expect(res.statusCode).toBe(200);
      expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/ops/health', headers: as('ta') })).statusCode).toBe(403);
    } finally {
      // Shutdown flushes the batch of spans to the collector.
      await ctx.close();
    }
    const traces = received.filter((r) => r.url === '/v1/traces');
    expect(traces.length).toBeGreaterThan(0);
    const body = traces.map((t) => t.body).join('\n');
    expect(traces[0]!.contentType).toMatch(/application\/json/);
    expect(body).toContain('GET /api/v1/ops/queues');
    expect(body).toContain('GET /api/v1/ops/health');
    expect(body).toContain(traceId);
    expect(body).toContain('mscd-api');
    expect(body).toContain('http.response.status_code');
    expect(body).not.toContain('tok-SECRET-55aa66bb');
  });

  it('sends nothing when telemetry is off', async () => {
    received.length = 0;
    const ctx = await createOpsApp(db, identities);
    try {
      expect(ctx.moduleRef.get(TelemetryService).http).toBeNull();
      expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/ops/queues', headers: as('ops') })).statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
    expect(received).toHaveLength(0);
  });

  it('builds the traces URL and strips query strings', () => {
    expect(tracesUrl('http://otel:4318')).toBe('http://otel:4318/v1/traces');
    expect(tracesUrl('http://otel:4318/')).toBe('http://otel:4318/v1/traces');
    expect(tracesUrl('https://collector.example/v1/traces')).toBe('https://collector.example/v1/traces');
    expect(pathOnly('/api/v1/x?code=1#f')).toBe('/api/v1/x');
  });
});
