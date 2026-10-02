// Contract tests of the route table (build plan J.3, D.1): every `RouteDef` of the shared route table is mounted by
// run mode `api` (or `storage-gateway` for `/v1` routes) with its method and path, and every mounted `/api/v1` and
// `/v1` route has a `RouteDef`; the OpenAPI document generates and lists every route except the test-only ones; a
// snapshot of route ids and methods guards the contract against silent changes.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { API_ROUTES, GATEWAY_ROUTES, buildOpenApiDocument, openApiPath, routes } from '@mscd/shared';
import type { FastifyInstance } from 'fastify';
import { Logger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayModule } from '../../../src/app/gateway.module';
import { gatewayAdapterOptions } from '../../../src/gateway/gateway-app';
import { configureHttpApplication } from '../../../src/modules/platform/http-app';
import { useTestDatabase } from '../../setup/test-db';
import { gatewayConfig, vaultEnv } from '../gateway/helpers';
import { anonymous, createFullApp, type FullApp } from './harness';

/** `METHOD /path` with Fastify parameters, as the route table writes it. */
const key = (method: string, path: string) => `${method} ${path}`;

describe('J.3 every route of the contract is mounted, and only those', () => {
  const db = useTestDatabase('empty');
  let full: FullApp;

  beforeAll(async () => {
    full = await createFullApp(db, { MSCD__TEST__ENDPOINTS_ENABLED: 'true' });
  });

  afterAll(async () => {
    await full?.close();
  });

  it('mounts every /api/v1 route of the route table with its method and path', () => {
    const missing = API_ROUTES.filter((r) => !full.mounted.has(key(r.method, r.path))).map((r) => `${r.id}: ${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('mounts no /api/v1 route that the route table does not define', () => {
    const defined = new Set(API_ROUTES.map((r) => key(r.method, r.path)));
    const extra = [...full.mounted].filter((m) => m.split(' ')[1]!.startsWith('/api/v1/') && !defined.has(m));
    expect(extra).toEqual([]);
  });

  it('answers 404 for a path under /api/ that no route defines (the guard fails closed)', async () => {
    const reply = await anonymous(full).get('/api/v1/no-such-route');
    expect(reply.status).toBe(404);
    expect(String(reply.headers['content-type'])).toMatch(/^application\/problem\+json/);
  });

  it('keeps test-only routes unreachable unless the profile enables them', async () => {
    const off = await createFullApp(db);
    try {
      for (const def of API_ROUTES.filter((r) => r.testOnly)) {
        const reply = await anonymous(off).request(def.method, def.path, { body: {} });
        expect(reply.status, def.id).toBe(404);
      }
    } finally {
      await off.close();
    }
  });
});

describe('J.3 the storage gateway mounts exactly the /v1 routes of the route table', () => {
  let app: NestFastifyApplication;
  const mounted = new Set<string>();

  beforeAll(async () => {
    const config = gatewayConfig(vaultEnv({ endpoint: 'http://127.0.0.1:9' }));
    const moduleRef = await Test.createTestingModule({ imports: [GatewayModule.forRoot(config)] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(gatewayAdapterOptions(config)), { logger: false });
    app.useLogger(app.get(Logger));
    await configureHttpApplication(app, config);
    const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
    fastify.addHook('onRoute', (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) if (method !== 'HEAD') mounted.add(key(method, route.url));
    });
    await app.init();
    await fastify.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('mounts every gateway route and nothing else under /v1', () => {
    const defined = new Set(GATEWAY_ROUTES.map((r) => key(r.method, r.path)));
    expect(GATEWAY_ROUTES.filter((r) => !mounted.has(key(r.method, r.path))).map((r) => r.id)).toEqual([]);
    expect([...mounted].filter((m) => m.split(' ')[1]!.startsWith('/v1/') && !defined.has(m))).toEqual([]);
  });
});

describe('J.3 OpenAPI document', () => {
  it('generates and documents every route except the test-only ones', () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { operationId?: string }>> };
    const documented = new Set<string>();
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) documented.add(`${method.toUpperCase()} ${path} ${operation.operationId ?? ''}`);
      }
    }
    const lines = [...documented];
    for (const r of routes) {
      const line = lines.find((l) => l.startsWith(`${r.method} ${openApiPath(r.path)} `));
      if (r.testOnly) expect(line, r.id).toBeUndefined();
      else expect(line, r.id).toBeDefined();
    }
    expect(documented.size).toBe(routes.filter((r) => !r.testOnly).length);
  });

  it('keeps the route ids and methods of the contract (snapshot)', () => {
    const table = routes.map((r) => `${r.id} ${r.method} ${r.path}${r.testOnly ? ' (test only)' : ''}`).sort();
    expect(table).toMatchSnapshot();
  });
});
