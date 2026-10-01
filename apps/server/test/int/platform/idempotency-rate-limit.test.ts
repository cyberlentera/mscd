// D.1 idempotency keys and F.3 rate limits with their PostgreSQL stores, through HTTP.
import { createHash } from 'node:crypto';
import { Controller, Req } from '@nestjs/common';
import { defineRoute, MsParams } from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiRoute, RouteInputParam, StreamedIdempotencyParam } from '../../../src/common/api-route';
import { idempotencyRequestHash } from '../../../src/common/api-route.interceptor';
import { BusinessRuleError } from '../../../src/common/problems';
import type { StreamedIdempotency } from '../../../src/common/route-state';
import { IDEMPOTENCY_LEASE_SECONDS } from '../../../src/modules/tenancy/idempotency-store';
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

const Uploaded = z.object({ ok: z.literal(true), changed: z.array(z.string()), data: z.object({ n: z.int(), size: z.int() }) });

const uploadBase = {
  owner: 'WP-08',
  method: 'POST',
  auth: 'session',
  summary: 'probe',
  body: z.object({}),
  requestType: 'multipart/form-data',
  response: Uploaded,
  status: 202,
  idempotent: true,
  errors: [409, 413],
} as const;

/** A multipart upload that claims its key with the SHA-256 of the file (like `admin.packs.import`). */
const uploadRoute = defineRoute({ ...uploadBase, id: 'probe.upload', path: '/api/v1/probe-uploads' });
/** A multipart upload whose handler forgets to claim the key. */
const uploadUnclaimedRoute = defineRoute({ ...uploadBase, id: 'probe.upload-unclaimed', path: '/api/v1/probe-uploads-unclaimed' });

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
let uploads = 0;

async function uploadedBytes(request: FastifyRequest): Promise<Buffer> {
  const file = await request.file();
  return file ? file.toBuffer() : Buffer.alloc(0);
}

@Controller()
class ProbeController {
  @ApiRoute(createRoute)
  create(@RouteInputParam('body') body: { title: string; fail?: boolean }) {
    counter += 1;
    if (body.fail) throw new BusinessRuleError('BR-17', { en: 'Owner required', id: 'Pemilik wajib diisi' });
    return { ok: true as const, changed: ['isms'], data: { n: counter, title: body.title } };
  }

  @ApiRoute(uploadRoute)
  async upload(@Req() request: FastifyRequest, @StreamedIdempotencyParam() idempotency: StreamedIdempotency) {
    const bytes = await uploadedBytes(request);
    await idempotency.claim(createHash('sha256').update(bytes).digest('hex'));
    uploads += 1;
    return { ok: true as const, changed: [], data: { n: uploads, size: bytes.length } };
  }

  @ApiRoute(uploadUnclaimedRoute)
  async uploadUnclaimed(@Req() request: FastifyRequest) {
    const bytes = await uploadedBytes(request);
    uploads += 1;
    return { ok: true as const, changed: [], data: { n: uploads, size: bytes.length } };
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
  let rina: string;

  beforeAll(async () => {
    ndt = await createTenant(db, 'ndt');
    bsd = await createTenant(db, 'bsd');
    rina = await addUser(db.migrator, 'rina', [ndt.id, bsd.id]);
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

  it('answers 409 with Retry-After while a key is in progress, and lets the same request take it over after the lease', async () => {
    const body = { title: 'Lost response' };
    const hash = idempotencyRequestHash(ndt.id, 'POST', '/api/v1/ms/isms/probe-items', body);
    // A claim whose response was never stored (the process died, or storing it failed).
    await inScope(db.migrator, { orgId: ndt.id }, (trx) =>
      trx
        .insertInto('platform.idempotency_key')
        .values({ organization_id: ndt.id, user_id: rina, key: 'key-0005', route: createRoute.id, request_hash: hash, status: null, response: null, expires_at: sql<Date>`now() + interval '24 hours'` })
        .execute(),
    );
    const runs = counter;
    const busy = await post('rina@ndt', body, 'key-0005');
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ messageKey: 'idempotency.in_progress' });
    const retryAfter = Number(busy.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(IDEMPOTENCY_LEASE_SECONDS - 30);
    expect(retryAfter).toBeLessThanOrEqual(IDEMPOTENCY_LEASE_SECONDS);
    expect(busy.json().retryAfter).toBe(retryAfter);
    expect((await post('rina@ndt', { title: 'Other' }, 'key-0005')).statusCode).toBe(409);
    expect(counter).toBe(runs);

    await inScope(db.migrator, { orgId: ndt.id }, (trx) =>
      trx
        .updateTable('platform.idempotency_key')
        .set({ created_at: sql<Date>`now() - ${IDEMPOTENCY_LEASE_SECONDS + 1} * interval '1 second'` })
        .where('key', '=', 'key-0005')
        .execute(),
    );
    const other = await post('rina@ndt', { title: 'Other' }, 'key-0005');
    expect(other.json()).toMatchObject({ messageKey: 'idempotency.key_reused' });
    const takenOver = await post('rina@ndt', body, 'key-0005');
    expect(takenOver.statusCode).toBe(201);
    expect(counter).toBe(runs + 1);
    const replayed = await post('rina@ndt', body, 'key-0005');
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expect(replayed.json()).toEqual(takenOver.json());
    expect(counter).toBe(runs + 1);
  });

  it('claims keys of multipart routes with a digest of the uploaded content', async () => {
    const send = (url: string, content: string, key?: string) => {
      const boundary = 'mscd-probe-boundary';
      const payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bundle.pack"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`,
      );
      return ctx.app.inject({
        method: 'POST',
        url,
        payload,
        headers: { [FAKE_PRINCIPAL_HEADER]: 'rina@ndt', 'content-type': `multipart/form-data; boundary=${boundary}`, ...(key ? { 'idempotency-key': key } : {}) },
      });
    };
    const first = await send('/api/v1/probe-uploads', 'pack bundle A', 'upload-0001');
    expect(first.statusCode).toBe(202);
    const runs = uploads;
    const again = await send('/api/v1/probe-uploads', 'pack bundle A', 'upload-0001');
    expect(again.statusCode).toBe(202);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(uploads).toBe(runs);
    const otherFile = await send('/api/v1/probe-uploads', 'pack bundle B', 'upload-0001');
    expect(otherFile.statusCode).toBe(409);
    expect(otherFile.json()).toMatchObject({ messageKey: 'idempotency.key_reused' });
    expect(uploads).toBe(runs);
    expect((await send('/api/v1/probe-uploads', 'pack bundle B')).statusCode).toBe(202);
    expect(uploads).toBe(runs + 1);

    // A handler that never claims its key is a 500 in development builds (the route's own tests catch it).
    expect((await send('/api/v1/probe-uploads-unclaimed', 'pack bundle C', 'upload-0002')).statusCode).toBe(500);
    expect((await send('/api/v1/probe-uploads-unclaimed', 'pack bundle C')).statusCode).toBe(202);
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
