// D.1 idempotency keys and F.3 rate limits with their PostgreSQL stores, through HTTP.
import { Controller } from '@nestjs/common';
import { defineRoute, MsParams } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiRoute, RouteInputParam } from '../../../src/common/api-route';
import { BusinessRuleError } from '../../../src/common/problems';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { RateLimitBucketStore } from '../../../src/modules/tenancy/rate-limit-store';
import { FAKE_PRINCIPAL_HEADER, type FakeIdentity } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addUser, inScope } from '../db/helpers';
import { createIntApp, infoOf, type IntApp } from './helpers';

const Created = z.object({ ok: z.literal(true), changed: z.array(z.string()), data: z.object({ n: z.int(), title: z.string() }) });

const createRoute = defineRoute({
  id: 'probe.idempotent-create',
  owner: 'WP-08',
  method: 'POST',
  path: '/api/v1/ms/:ms/probe-items',
  auth: 'session',
  summary: 'probe',
  permission: 'register.manage',
  scope: 'ms',
  params: MsParams,
  body: z.strictObject({ title: z.string().min(1), fail: z.boolean().optional() }),
  response: Created,
  status: 201,
  idempotent: true,
  errors: [409, 422],
});

const limitedRoute = defineRoute({
  id: 'probe.limited',
  owner: 'WP-08',
  method: 'POST',
  path: '/api/v1/probe-limited',
  auth: 'public',
  summary: 'probe',
  body: z.strictObject({ email: z.email() }),
  response: z.object({ ok: z.literal(true) }),
  rateLimits: [{ key: 'email', max: 2, windowSeconds: 900 }],
  errors: [429],
});

let counter = 0;

@Controller()
class ProbeController {
  @ApiRoute(createRoute)
  create(@RouteInputParam('body') body: { title: string; fail?: boolean }) {
    counter += 1;
    if (body.fail) throw new BusinessRuleError('BR-17', { en: 'Owner required', id: 'Pemilik wajib diisi' });
    return { ok: true as const, changed: ['isms'], data: { n: counter, title: body.title } };
  }

  @ApiRoute(limitedRoute)
  limited() {
    return { ok: true as const };
  }
}

describe('idempotency keys (D.1)', () => {
  const db = useTestDatabase('empty');
  let ctx: IntApp;
  let ndt: CreatedTenant;
  let bsd: CreatedTenant;

  beforeAll(async () => {
    ndt = await createTenant(db, 'ndt');
    bsd = await createTenant(db, 'bsd');
    const rina = await addUser(db.migrator, 'rina', [ndt.id, bsd.id]);
    const identities: Record<string, FakeIdentity> = {
      'rina@ndt': { user: { id: rina, handle: 'rina' }, org: infoOf(ndt), rolesByMs: { isms: ['ms_manager'] } },
      'rina@bsd': { user: { id: rina, handle: 'rina' }, org: infoOf(bsd), rolesByMs: { isms: ['ms_manager'] } },
    };
    ctx = await createIntApp(db, { controllers: [ProbeController] }, { auth: { identities } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const post = (who: string, body: unknown, key?: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/ms/isms/probe-items',
      headers: { [FAKE_PRINCIPAL_HEADER]: who, ...(key ? { 'idempotency-key': key } : {}) },
      payload: body as object,
    });

  it('replays the first response for the same key and request, without running the command again', async () => {
    const first = await post('rina@ndt', { title: 'Risk A' }, 'key-0001');
    expect(first.statusCode).toBe(201);
    const runs = counter;
    const again = await post('rina@ndt', { title: 'Risk A' }, 'key-0001');
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(counter).toBe(runs);
    const stored = await inScope(db.migrator, { orgId: ndt.id }, (trx) =>
      trx.selectFrom('platform.idempotency_key').select(['route', 'status', 'request_hash']).where('key', '=', 'key-0001').execute(),
    );
    expect(stored).toEqual([{ route: 'probe.idempotent-create', status: 201, request_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });

  it('answers 409 for a different request with the same key', async () => {
    await post('rina@ndt', { title: 'Risk B' }, 'key-0002');
    const reused = await post('rina@ndt', { title: 'Something else' }, 'key-0002');
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/conflict', messageKey: 'idempotency.key_reused' });
  });

  it('never replays across organisations (J.5)', async () => {
    const inNdt = await post('rina@ndt', { title: 'Same' }, 'key-0003');
    const inBsd = await post('rina@bsd', { title: 'Same' }, 'key-0003');
    expect(inBsd.statusCode).toBe(201);
    expect(inBsd.headers['idempotent-replayed']).toBeUndefined();
    expect(inBsd.json().data.n).toBe(inNdt.json().data.n + 1);
    const visibleInBsd = await inScope(db.migrator, { orgId: bsd.id }, (trx) =>
      trx.selectFrom('platform.idempotency_key').select(['organization_id', 'key']).execute(),
    );
    expect(visibleInBsd.map((r) => r.organization_id)).toEqual([bsd.id]);
  });

  it('releases the key when the command fails, so a retry runs again', async () => {
    const failed = await post('rina@ndt', { title: 'Bad', fail: true }, 'key-0004');
    expect(failed.statusCode).toBe(422);
    const runs = counter;
    const retried = await post('rina@ndt', { title: 'Bad', fail: true }, 'key-0004');
    expect(retried.statusCode).toBe(422);
    expect(counter).toBe(runs + 1);
  });

  it('rejects a malformed key and runs without a key as usual', async () => {
    const bad = await post('rina@ndt', { title: 'X' }, 'k'.repeat(101));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0].path).toBe('headers.idempotency-key');
    const runs = counter;
    await post('rina@ndt', { title: 'No key' });
    await post('rina@ndt', { title: 'No key' });
    expect(counter).toBe(runs + 2);
  });
});

describe('rate limits with the PostgreSQL store (F.3)', () => {
  const db = useTestDatabase('empty');
  let ctx: IntApp;

  beforeAll(async () => {
    ctx = await createIntApp(db, { controllers: [ProbeController] });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('counts hits in platform.rate_limit_bucket and starts a new window when one has passed', async () => {
    const store = ctx.moduleRef.get(RateLimitBucketStore);
    expect(await store.hit('test:window', 60_000)).toMatchObject({ current: 1 });
    const second = await store.hit('test:window', 60_000);
    expect(second.current).toBe(2);
    expect(second.ttlMs).toBeGreaterThan(55_000);
    expect(second.ttlMs).toBeLessThanOrEqual(60_000);
    await store.hit('test:short', 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store.hit('test:short', 1)).current).toBe(1);
    await expect(store.hit('x'.repeat(201), 1000)).rejects.toThrow(/200 characters/);
  });

  it('answers 429 with Retry-After once the route limit is reached, keyed by normalised email', async () => {
    const send = (email: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/probe-limited', payload: { email } });
    expect((await send('maya@test.invalid')).statusCode).toBe(200);
    expect((await send('MAYA@test.invalid')).statusCode).toBe(200);
    const limited = await send('maya@test.invalid');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(800);
    expect(limited.json()).toMatchObject({ status: 429, retryAfter: Number(limited.headers['retry-after']) });
    expect((await send('other@test.invalid')).statusCode).toBe(200);
    const { rows } = await sql<{ key: string; hits: number }>`select key, hits from platform.rate_limit_bucket where key like 'probe.limited:%' order by hits desc`.execute(db.app);
    expect(rows[0]).toMatchObject({ hits: 3 });
    expect(rows[0]!.key).toMatch(/^probe\.limited:email:2\/900:[0-9a-f]{40}$/);
    expect(rows.map((r) => r.key).join(' ')).not.toContain('maya');
    expect(await ctx.moduleRef.get(RateLimitBucketStore).purgeExpired()).toBeGreaterThanOrEqual(0);
  });
});
