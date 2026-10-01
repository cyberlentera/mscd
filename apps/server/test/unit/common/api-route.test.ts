// The request pipeline of contract routes (D.1, F.3, F.7, F.12): `@ApiRoute`, the authorisation guard with fake
// authentication, input and response validation, problem details, request ids, rate limits, test-only routes and
// read-only mode. No database: the rate limit plugin counts in memory here (the PostgreSQL store is covered by the
// integration tests).
import { Controller, Get } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { defineRoute, MsParams, type RouteDef } from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiRoute, CurrentAuthz, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../../src/common/api-route';
import { assertIfMatch, etagOf } from '../../../src/common/etag';
import { CsrfError, ReadOnlyModeError } from '../../../src/common/problems';
import { currentRequestContext } from '../../../src/common/request-context';
import { LICENCE_GATE, SESSION_RESOLVER, type AuthzState, type Principal } from '../../../src/common/tokens';
import { FAKE_PRINCIPAL_HEADER, FakeSessionResolver, type FakeIdentity } from '../../setup/auth-fakes';
import { createTestApp, RecordingAuditWriter, tenantInfo, unitConfig } from './http-helpers';

const NDT = tenantInfo('ndt', '00000000-0000-4000-8000-00000000a001');
const Ok = z.object({ ok: z.literal(true) }).passthrough();

const base = { owner: 'WP-08' as const, summary: 'probe', errors: [] as number[], response: Ok };
const routes = {
  public: defineRoute({ ...base, id: 'probe.public', method: 'GET', path: '/api/v1/probe/public', auth: 'public' }),
  session: defineRoute({ ...base, id: 'probe.session', method: 'GET', path: '/api/v1/probe/session', auth: 'session' }),
  msRead: defineRoute({ ...base, id: 'probe.ms-read', method: 'GET', path: '/api/v1/ms/:ms/probe', auth: 'session', permission: 'ms.read', scope: 'ms', params: MsParams }),
  create: defineRoute({
    ...base,
    id: 'probe.create',
    method: 'POST',
    path: '/api/v1/ms/:ms/probe',
    auth: 'session',
    permission: 'risk.manage',
    scope: 'ms',
    params: MsParams,
    body: z.strictObject({ title: z.string().min(1), count: z.int() }),
    status: 201,
  }),
  orgOnly: defineRoute({ ...base, id: 'probe.org', method: 'GET', path: '/api/v1/probe/org', auth: 'session', permission: 'storage.repository.read', scope: 'org' }),
  anyOf: defineRoute({
    ...base,
    id: 'probe.any-of',
    method: 'GET',
    path: '/api/v1/probe/trail',
    auth: 'session',
    anyOf: [
      { permission: 'audit_trail.read', scope: 'ms' },
      { permission: 'audit_trail.metadata.read', scope: 'org' },
    ],
    msSource: 'query',
    query: z.strictObject({ ms: z.string().optional() }),
  } as unknown as RouteDef),
  bad: defineRoute({ ...base, id: 'probe.bad', method: 'GET', path: '/api/v1/probe/bad', auth: 'public' }),
  testOnly: defineRoute({ ...base, id: 'probe.test-only', method: 'POST', path: '/api/v1/probe/test-only', auth: 'public', testOnly: true }),
  login: defineRoute({
    ...base,
    id: 'probe.login',
    method: 'POST',
    path: '/api/v1/probe/login',
    auth: 'public',
    body: z.strictObject({ email: z.email() }),
    rateLimits: [
      { key: 'ip', max: 3, windowSeconds: 60 },
      { key: 'email', max: 2, windowSeconds: 60 },
    ],
  }),
  write: defineRoute({ ...base, id: 'probe.write', method: 'POST', path: '/api/v1/probe/write', auth: 'session' }),
  writeAllowed: defineRoute({ ...base, id: 'probe.write-allowed', method: 'POST', path: '/api/v1/probe/write-allowed', auth: 'session', readOnlyAllowed: true }),
  context: defineRoute({ ...base, id: 'probe.context', method: 'GET', path: '/api/v1/ms/:ms/context', auth: 'session', permission: 'ms.read', scope: 'ms', params: MsParams }),
  transition: defineRoute({ ...base, id: 'probe.transition', method: 'POST', path: '/api/v1/probe/transition', auth: 'public', ifMatch: true, errors: [412] }),
};

const RECORD_UPDATED_AT = new Date('2026-09-29T03:15:00.000Z');

@Controller()
class ProbeController {
  @ApiRoute(routes.public)
  pub() {
    return { ok: true };
  }

  @ApiRoute(routes.session)
  session(@CurrentPrincipal() principal: Principal) {
    return { ok: true, user: principal.user.handle };
  }

  @ApiRoute(routes.msRead)
  msRead(@CurrentAuthz() authz: AuthzState) {
    return { ok: true, ms: authz.ms, ownOnly: authz.ownOnly, granted: Object.fromEntries(authz.granted) };
  }

  @ApiRoute(routes.create)
  create(@RouteInputParam('body') body: { title: string; count: number }) {
    return { ok: true, body };
  }

  @ApiRoute(routes.orgOnly)
  org() {
    return { ok: true };
  }

  @ApiRoute(routes.anyOf)
  trail(@CurrentAuthz() authz: AuthzState) {
    return { ok: true, granted: [...authz.granted.keys()].sort() };
  }

  @ApiRoute(routes.bad)
  bad() {
    return { ok: 'yes' };
  }

  @ApiRoute(routes.testOnly)
  testOnly() {
    return { ok: true };
  }

  @ApiRoute(routes.login)
  login() {
    return { ok: true };
  }

  @ApiRoute(routes.write)
  write() {
    return { ok: true };
  }

  @ApiRoute(routes.writeAllowed)
  writeAllowed() {
    return { ok: true };
  }

  @ApiRoute(routes.context)
  context() {
    const ctx = currentRequestContext();
    return { ok: true, ctx: { ...ctx } };
  }

  @ApiRoute(routes.transition)
  transition(@IfMatchHeader() ifMatch: string | undefined) {
    assertIfMatch(ifMatch, RECORD_UPDATED_AT);
    return { ok: true, etag: etagOf(RECORD_UPDATED_AT) };
  }

  /** A route under /api without a contract definition: the guard must refuse it. */
  @Get('api/v1/probe/unlisted')
  unlisted() {
    return { leaked: true };
  }
}

const identities: Record<string, FakeIdentity> = {
  rina: { user: { id: '8c0d6f1e-2a3b-4c5d-9e6f-7a8b9c0d1e21', handle: 'rina' }, org: NDT, rolesByMs: { isms: ['ms_manager'], qms: ['ms_manager'] } },
  bagus: { user: { id: '8c0d6f1e-2a3b-4c5d-9e6f-7a8b9c0d1e22', handle: 'bagus' }, org: NDT, rolesByMs: { isms: ['domain_owner'] } },
  admin: { user: { id: '8c0d6f1e-2a3b-4c5d-9e6f-7a8b9c0d1e23', handle: 'tenant.admin' }, org: NDT, orgRoles: ['tenant_admin'], knownMs: ['isms', 'qms'] },
  pending: { user: { id: '8c0d6f1e-2a3b-4c5d-9e6f-7a8b9c0d1e24', handle: 'pending' }, org: NDT, sessionState: 'mfa_pending' },
};

const as = (name: string) => ({ [FAKE_PRINCIPAL_HEADER]: name });

describe('contract routes through the guard (D.1, F.7)', () => {
  let app: NestFastifyApplication;
  const audit = new RecordingAuditWriter();

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] }, { auth: { identities }, audit });
  });
  afterAll(() => app?.close());

  it('serves public routes and echoes the request id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/probe/public', headers: { 'x-request-id': 'trace-0001-abcd' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers['x-request-id']).toBe('trace-0001-abcd');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers 401 problem details without a session, with the request id in the body', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/probe/session', headers: { 'x-request-id': 'trace-0002-abcd' } });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(response.json()).toEqual({
      type: 'https://mscd.cyberlentera.com/problems/unauthenticated',
      title: 'Sign-in required',
      status: 401,
      requestId: 'trace-0002-abcd',
    });
    const replaced = await app.inject({ method: 'GET', url: '/api/v1/probe/session', headers: { 'x-request-id': 'bad id with spaces' } });
    expect(replaced.json().requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(replaced.json().requestId).toBe(replaced.headers['x-request-id']);
  });

  it('checks the session state against the auth level', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe/session', headers: as('pending') })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/api/v1/probe/session', headers: as('rina') });
    expect(ok.json()).toEqual({ ok: true, user: 'rina' });
  });

  it('evaluates the permission in the system of the path', async () => {
    const full = await app.inject({ method: 'GET', url: '/api/v1/ms/isms/probe', headers: as('rina') });
    expect(full.statusCode).toBe(200);
    expect(full.json()).toEqual({ ok: true, ms: 'isms', ownOnly: false, granted: { 'ms.read': 'full' } });
    const own = await app.inject({ method: 'GET', url: '/api/v1/ms/isms/probe', headers: as('bagus') });
    expect(own.json()).toMatchObject({ ms: 'isms', ownOnly: true, granted: { 'ms.read': 'own' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/ms/qms/probe', headers: as('bagus') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/ms/zzz/probe', headers: as('rina') })).statusCode).toBe(404);
  });

  it('answers 403 and audits the denial once per user, route and minute', async () => {
    const before = audit.entries.length;
    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/ms/isms/probe', headers: as('admin') });
      expect(response.statusCode).toBe(403);
      expect(response.json().type).toBe('https://mscd.cyberlentera.com/problems/forbidden');
    }
    const denials = audit.entries.slice(before);
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      entry: { action: 'authz.denied', msSlug: 'isms', entityCode: 'probe.ms-read', after: { routeId: 'probe.ms-read', permissions: ['ms.read'], ms: 'isms' } },
      target: { orgId: NDT.id, schema: 'org_ndt' },
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe/org', headers: as('admin') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe/org', headers: as('bagus') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe/org', headers: as('rina') })).statusCode).toBe(200);
  });

  it('validates params and body before the handler and uses the route status', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/ms/isms/probe', headers: as('rina'), payload: { title: 'Risk', count: 2 } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ ok: true, body: { title: 'Risk', count: 2 } });
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/ms/isms/probe', headers: as('rina'), payload: { title: '', extra: 1 } });
    expect(invalid.statusCode).toBe(400);
    const problem = invalid.json();
    expect(problem.type).toBe('https://mscd.cyberlentera.com/problems/validation');
    expect(problem.errors.map((e: { path: string }) => e.path).sort()).toEqual(['body', 'body.count', 'body.title']);
    const badParams = await app.inject({ method: 'POST', url: '/api/v1/ms/ISMS/probe', headers: as('rina'), payload: { title: 'x', count: 1 } });
    expect(badParams.statusCode).toBe(400);
    expect(badParams.json().errors[0].path).toBe('params.ms');
    const notJson = await app.inject({ method: 'POST', url: '/api/v1/ms/isms/probe', headers: { ...as('rina'), 'content-type': 'application/json' }, payload: '{bad' });
    expect(notJson.statusCode).toBe(400);
    expect(notJson.headers['content-type']).toBe('application/problem+json; charset=utf-8');
  });

  it('passes anyOf routes on one alternative; an ms alternative needs the system of the request', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe/trail?ms=isms', headers: as('rina') })).json()).toEqual({ ok: true, granted: ['audit_trail.read'] });
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe/trail', headers: as('rina') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe/trail', headers: as('admin') })).json()).toEqual({ ok: true, granted: ['audit_trail.metadata.read'] });
  });

  it('validates responses against the contract in development builds', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/probe/bad' });
    expect(response.statusCode).toBe(500);
    expect(Object.keys(response.json()).sort()).toEqual(['requestId', 'status', 'title', 'type']);
  });

  it('hides test-only routes unless the profile enables them, and refuses routes without a contract', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/probe/test-only' })).statusCode).toBe(404);
    const unlisted = await app.inject({ method: 'GET', url: '/api/v1/probe/unlisted', headers: as('rina') });
    expect(unlisted.statusCode).toBe(404);
    expect(unlisted.body).not.toContain('leaked');
    expect((await app.inject({ method: 'GET', url: '/api/v1/nothing/here' })).statusCode).toBe(404);
  });

  it('applies route rate limits per IP and per email with the F.3 headers', async () => {
    const send = (email: string) => app.inject({ method: 'POST', url: '/api/v1/probe/login', payload: { email }, remoteAddress: '198.51.100.7' });
    const first = await send('a@test.invalid');
    expect(first.statusCode).toBe(200);
    expect(first.headers['ratelimit-limit']).toBeDefined();
    expect(first.headers['ratelimit-remaining']).toBeDefined();
    expect(first.headers['ratelimit-reset']).toBeDefined();
    expect((await send('A@test.invalid ')).statusCode).toBe(400);
    expect((await send('a@test.invalid')).statusCode).toBe(200);
    const byEmail = await send('a@test.invalid');
    expect(byEmail.statusCode).toBe(429);
    const problem = byEmail.json();
    expect(problem.type).toBe('https://mscd.cyberlentera.com/problems/rate-limited');
    expect(problem.retryAfter).toBeGreaterThan(0);
    expect(byEmail.headers['retry-after']).toBe(String(problem.retryAfter));
    expect(byEmail.headers['ratelimit-remaining']).toBe('0');
    const byIp = await send('b@test.invalid');
    expect(byIp.statusCode).toBe(429);
    const otherIp = await app.inject({ method: 'POST', url: '/api/v1/probe/login', payload: { email: 'c@test.invalid' }, remoteAddress: '198.51.100.8' });
    expect(otherIp.statusCode).toBe(200);
  });

  it('hands If-Match to the service and answers 412 for a stale version (D.1 Concurrency)', async () => {
    const send = (ifMatch?: string) =>
      app.inject({ method: 'POST', url: '/api/v1/probe/transition', headers: ifMatch ? { 'if-match': ifMatch } : {} });
    expect((await send()).statusCode).toBe(200);
    expect((await send(etagOf(RECORD_UPDATED_AT))).statusCode).toBe(200);
    const stale = await send('W/"1"');
    expect(stale.statusCode).toBe(412);
    expect(stale.json().type).toBe('https://mscd.cyberlentera.com/problems/precondition-failed');
  });

  it('applies the per-user limit to authenticated requests', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/probe/session', headers: as('rina') });
    expect(response.headers['ratelimit-limit']).toBe('600');
  });

  it('keeps the request context: request id, route, user, organisation and system', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/ms/isms/context', headers: { ...as('rina'), 'x-request-id': 'trace-ctx-0001', 'user-agent': 'probe/1' } });
    expect(response.json().ctx).toMatchObject({
      requestId: 'trace-ctx-0001',
      routeId: 'probe.context',
      userId: identities.rina!.user.id,
      actorKind: 'user',
      orgId: NDT.id,
      orgSlug: 'ndt',
      schema: 'org_ndt',
      ms: 'isms',
      userAgent: 'probe/1',
      ip: '127.0.0.1',
    });
  });
});

describe('profile switches and service hooks', () => {
  it('mounts test-only routes when demo and test endpoints are enabled', async () => {
    const app = await createTestApp({ controllers: [ProbeController] }, { config: unitConfig({ MSCD__TEST__ENDPOINTS_ENABLED: 'true' }) });
    try {
      expect((await app.inject({ method: 'POST', url: '/api/v1/probe/test-only' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('blocks writes in read-only mode except for readOnlyAllowed routes (BR-37)', async () => {
    const app = await createTestApp(
      { controllers: [ProbeController] },
      {
        auth: { identities },
        overrides: (builder) =>
          builder.overrideProvider(LICENCE_GATE).useValue({
            assertWritable: async () => {
              throw new ReadOnlyModeError();
            },
            assertCanAddUser: async () => undefined,
            assertCanAddMs: async () => undefined,
            assertFeature: async () => undefined,
            isAdapterLicensed: async () => true,
          }),
      },
    );
    try {
      const blocked = await app.inject({ method: 'POST', url: '/api/v1/probe/write', headers: as('rina') });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/read-only-mode', rule: 'BR-37' });
      expect((await app.inject({ method: 'POST', url: '/api/v1/probe/write-allowed', headers: as('rina') })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/v1/probe/session', headers: as('rina') })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('runs the session resolver request checks (CSRF hook of WP-11)', async () => {
    const fake = new FakeSessionResolver(identities, 'rina');
    const resolver = {
      resolve: (request: FastifyRequest) => fake.resolve(request),
      verifyRequest: async (request: FastifyRequest) => {
        if (request.method !== 'GET' && request.headers['x-csrf-token'] !== 'token-1') throw new CsrfError();
      },
    };
    const app = await createTestApp({ controllers: [ProbeController] }, { overrides: (builder) => builder.overrideProvider(SESSION_RESOLVER).useValue(resolver) });
    try {
      const refused = await app.inject({ method: 'POST', url: '/api/v1/probe/write' });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().type).toBe('https://mscd.cyberlentera.com/problems/csrf');
      expect((await app.inject({ method: 'POST', url: '/api/v1/probe/write', headers: { 'x-csrf-token': 'token-1' } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('denies every permission with the default evaluator and authenticates nobody with the default resolver', async () => {
    const app = await createTestApp({ controllers: [ProbeController] });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/probe/session' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/v1/probe/public' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
    const denyAll = await createTestApp(
      { controllers: [ProbeController] },
      { overrides: (builder) => builder.overrideProvider(SESSION_RESOLVER).useValue(new FakeSessionResolver(identities, 'rina')) },
    );
    try {
      expect((await denyAll.inject({ method: 'GET', url: '/api/v1/probe/session' })).statusCode).toBe(200);
      expect((await denyAll.inject({ method: 'GET', url: '/api/v1/ms/isms/probe' })).statusCode).toBe(403);
    } finally {
      await denyAll.close();
    }
  });
});
