// API isolation between organisations (build plan J.5, D-02, F.7, F.10): a user signed in to `tst` gets 404 for
// every route that names a system of `ndt` only and for every record of `ndt` (also through `isms`, a slug both
// organisations have); slugs resolve in the session's organisation only; the admin lists (`/admin/users`,
// `/admin/identity-providers`, `GET /license`, `/admin/audit-trail`, `/admin/storage/*`) of one organisation never
// show rows of the other, also for a Tenant Admin of both; idempotency keys do not replay across organisations.
import { API_ROUTES, pathParamNames, routeById, type RouteDef } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import {
  ORG_IDS, callRoute, createFullApp, demoSession, exampleInput, examplesOf, msIdOf, resetRateLimits, rowsIn, type Client, type FullApp,
} from '../contract/harness';
import { DIRECT, ID_TABLES } from './record-tables';

/** Signed-in routes that read a system (path, body or query). */
const MS_ROUTES: readonly RouteDef[] = API_ROUTES.filter(
  (r) => r.auth === 'session' && !r.testOnly && (r.msSource !== undefined || pathParamNames(r.path).includes('ms')),
);

describe('J.5 isolation between organisations', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  /** rina, Tenant Admin and MS Manager of ndt and tst, signed in to tst. */
  let rinaTst: Client;
  let rinaNdt: Client;
  let ndtIsms: string;

  beforeAll(async () => {
    full = await createFullApp(db);
    rinaTst = await demoSession(full, db, 'rina', 'tst');
    rinaNdt = await demoSession(full, db, 'rina', 'ndt');
    ndtIsms = await msIdOf(db, 'ndt', 'isms');
  });

  afterAll(async () => {
    await full?.close();
  });

  it('answers 404 to a tst session on every route that names a system only ndt has', async () => {
    expect(MS_ROUTES.length).toBeGreaterThanOrEqual(90);
    const problems: string[] = [];
    for (const def of MS_ROUTES) {
      await resetRateLimits(db);
      let input = exampleInput(def, { ms: 'qms' });
      if (def.msSource === 'body' || def.msSource === 'query') {
        // An example that names a system (`POST /exports` has organisation-wide types without one).
        const named = (examplesOf(def.msSource === 'body' ? def.body : def.query) as Record<string, unknown>[]).find((e) => e && 'ms' in e);
        const member = { ...(named ?? {}), ms: 'qms' };
        input = { ...input, ...(def.msSource === 'body' ? { body: member } : { query: member }) };
      }
      const reply = await callRoute(rinaTst, def, input);
      if (reply.status !== 404) problems.push(`${def.id}: ${reply.status} ${reply.text.slice(0, 160)}`);
      problems.push(...reply.violations);
    }
    expect(problems).toEqual([]);
  });

  it('answers 404 to a tst session for every ndt record named through isms, a slug both organisations have', async () => {
    const problems: string[] = [];
    const ndtRecord = async (table: string): Promise<string | undefined> =>
      DIRECT.has(table)
        ? (await rowsIn<{ id: string }>(db, 'ndt', sql`select id from ${sql.table(table)} where management_system_id = ${ndtIsms} and deleted_at is null limit 1`))[0]?.id
        : (await rowsIn<{ id: string }>(db, 'ndt', sql`select x.id from ${sql.table(table)} x where x.deleted_at is null and exists (select 1 from entity_ms_link l
            where l.entity_type = ${table} and l.entity_id = x.id and l.management_system_id = ${ndtIsms} and l.deleted_at is null) limit 1`))[0]?.id;
    let checked = 0;
    for (const [routeId, table] of Object.entries(ID_TABLES)) {
      const id = await ndtRecord(table);
      if (!id) continue;
      const def = routeById(routeId);
      const params: Record<string, string> = { ms: 'isms', id };
      if (routeId === 'registers.update') params.register = 'risks';
      if (routeId === 'evidence.targets.remove') params.targetId = id;
      await resetRateLimits(db);
      const reply = await callRoute(rinaTst, def, exampleInput(def, { ms: 'isms', ids: { id }, override: { params } }));
      checked += 1;
      if (reply.status !== 404) problems.push(`${routeId} (${table}): ${reply.status} ${reply.text.slice(0, 160)}`);
      problems.push(...reply.violations);
    }
    expect(checked).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  });

  it('resolves a slug both organisations have in the session organisation only', async () => {
    const tst = await rinaTst.get<{ ms: { id: string }; refs: Record<string, { id: string }> }>('/api/v1/ui/ms/isms');
    const ndt = await rinaNdt.get<{ ms: { id: string }; refs: Record<string, { id: string }> }>('/api/v1/ui/ms/isms');
    expect(tst.status).toBe(200);
    expect(ndt.status).toBe(200);
    const tstIds = new Set(Object.values(tst.body.refs).map((r) => r.id));
    const ndtIds = new Set(Object.values(ndt.body.refs).map((r) => r.id));
    expect(tstIds.size).toBeGreaterThan(50);
    for (const id of tstIds) expect(ndtIds.has(id), id).toBe(false);
    const [inTst] = await rowsIn<{ n: number }>(db, 'tst', sql`select count(*)::int as n from applicability_entry where id = any(${[...tstIds]}::uuid[])`);
    expect(inTst!.n).toBeGreaterThan(0);
  });

  describe('admin lists of a Tenant Admin of both organisations, signed in to tst', () => {
    it('GET /admin/users lists members of tst only', async () => {
      const members = new Set(
        (await inScope(db.migrator, { platformScope: true }, (trx) =>
          sql<{ handle: string }>`select u.handle from platform.org_membership m join platform.app_user u on u.id = m.user_id
            where m.organization_id = ${ORG_IDS.tst} and m.deleted_at is null`.execute(trx),
        )).rows.map((r) => r.handle),
      );
      const reply = await callRoute<{ items: { handle: string }[]; total: number }>(rinaTst, routeById('admin.users.list'), { query: { pageSize: 200 } });
      expect(reply.status, reply.text).toBe(200);
      expect(reply.violations).toEqual([]);
      expect(reply.body.items.length).toBe(reply.body.total);
      for (const item of reply.body.items) expect(members.has(item.handle), item.handle).toBe(true);
      expect(reply.body.items.map((i) => i.handle)).not.toContain('staff01');
    });

    it('GET /admin/identity-providers lists the providers of tst only', async () => {
      await inScope(db.migrator, { platformScope: true }, (trx) =>
        sql`insert into platform.identity_provider (organization_id, slug, kind, display_name, oidc_issuer, oidc_client_id)
            values (${ORG_IDS.ndt}, 'wp30-ndt-idp', 'oidc', 'NDT only', 'https://idp.ndt.example', 'mscd')`.execute(trx),
      );
      const tst = await callRoute<{ slug: string }[]>(rinaTst, routeById('admin.idp.list'), {});
      const ndt = await callRoute<{ slug: string }[]>(rinaNdt, routeById('admin.idp.list'), {});
      expect(tst.status).toBe(200);
      expect(tst.violations).toEqual([]);
      expect(tst.body.map((p) => p.slug)).not.toContain('wp30-ndt-idp');
      expect(ndt.body.map((p) => p.slug)).toContain('wp30-ndt-idp');
    });

    it('GET /license shows the licence of tst', async () => {
      const reply = await callRoute<{ licenseId: string; binding: { organizationId?: string } }>(rinaTst, routeById('license.get'), {});
      expect(reply.status, reply.text).toBe(200);
      expect(reply.violations).toEqual([]);
      expect(reply.body.licenseId).toBe('LIC-DEMO-TST');
      expect(reply.body.binding.organizationId).toBe(ORG_IDS.tst);
    });

    it('GET /admin/audit-trail lists entries of tst only (metadata and the full view of a system)', async () => {
      // A register entry in ndt, and a denial in tst (the demo seed writes no audit entries).
      const asset = { code: 'AS-NDT-ONLY', title: 'ndt asset', ownerHandle: 'bagus', assetType: 'infrastructure', classification: 'internal', linkedMs: ['isms'] };
      expect((await rinaNdt.post('/api/v1/ms/isms/registers/assets', asset)).status).toBe(201);
      const bagusTst = await demoSession(full, db, 'bagus', 'tst');
      expect((await bagusTst.post('/api/v1/ms/isms/phases/1/verify', {})).status).toBe(403);
      const tstTenant = new Set((await rowsIn<{ seq: string; action: string }>(db, 'tst', sql`select seq::text, action from audit_trail`)).map((r) => `${r.seq}|${r.action}`));
      const tstPlatform = new Set(
        (await inScope(db.migrator, { platformScope: true }, (trx) =>
          sql<{ seq: string; action: string }>`select seq::text, action from platform.audit_log where organization_id = ${ORG_IDS.tst}`.execute(trx),
        )).rows.map((r) => `${r.seq}|${r.action}`),
      );
      for (const query of [{ pageSize: 200 }, { ms: 'isms', pageSize: 200 }]) {
        const reply = await callRoute<{ items: { seq: number; action: string }[] }>(rinaTst, routeById('audit-trail.list'), { query });
        expect(reply.status, reply.text).toBe(200);
        expect(reply.violations).toEqual([]);
        expect(reply.body.items.length).toBeGreaterThan(0);
        for (const item of reply.body.items) {
          const key = `${item.seq}|${item.action}`;
          expect(tstTenant.has(key) || tstPlatform.has(key), `${JSON.stringify(query)} ${key}`).toBe(true);
          expect(item.action).not.toBe('register.created');
        }
      }
    });

    it('GET /admin/storage/* lists repositories, routing rules and objects of tst only', async () => {
      const repos = new Set((await rowsIn<{ id: string }>(db, 'tst', sql`select id from storage_repository`)).map((r) => r.id));
      const rules = new Set((await rowsIn<{ id: string }>(db, 'tst', sql`select id from storage_routing_rule`)).map((r) => r.id));
      const objects = new Set((await rowsIn<{ id: string }>(db, 'tst', sql`select id from storage_object`)).map((r) => r.id));
      const ndtObjects = new Set((await rowsIn<{ id: string }>(db, 'ndt', sql`select id from storage_object`)).map((r) => r.id));
      const listed = await callRoute<{ ref: string }[]>(rinaTst, routeById('admin.storage.repositories.list'), {});
      expect(listed.status, listed.text).toBe(200);
      expect(listed.violations).toEqual([]);
      for (const r of listed.body) expect(repos.has(r.ref), r.ref).toBe(true);
      const routing = await callRoute<{ id: string }[]>(rinaTst, routeById('admin.storage.routing-rules.list'), {});
      expect(routing.status).toBe(200);
      for (const r of routing.body) expect(rules.has(r.id), r.id).toBe(true);
      const objectsDef = routeById('admin.storage.objects.list');
      const listedObjects = await callRoute(rinaTst, objectsDef, exampleInput(objectsDef, { override: { query: {} } }));
      expect(listedObjects.status, listedObjects.text).toBe(200);
      expect(listedObjects.violations).toEqual([]);
      const ids = JSON.stringify(listedObjects.body).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
      for (const id of ids) expect(ndtObjects.has(id) && !objects.has(id), id).toBe(false);
    });
  });

  it('does not replay an idempotency key across organisations', async () => {
    const def = routeById('registers.create');
    const body = { code: 'AS-IDEM', title: 'Idempotent asset', ownerHandle: 'bagus', assetType: 'infrastructure', classification: 'internal', linkedMs: ['isms'] };
    const headers = { 'idempotency-key': 'wp30-same-key-across-organisations' };
    const ndt = await callRoute<{ ref: { id: string } }>(rinaNdt, def, { params: { ms: 'isms', register: 'assets' }, body }, headers);
    expect(ndt.status, ndt.text).toBe(201);
    const replay = await callRoute<{ ref: { id: string } }>(rinaNdt, def, { params: { ms: 'isms', register: 'assets' }, body }, headers);
    expect(replay.status).toBe(201);
    expect(replay.body.ref.id).toBe(ndt.body.ref.id);
    const tst = await callRoute<{ ref: { id: string } }>(rinaTst, def, { params: { ms: 'isms', register: 'assets' }, body }, headers);
    expect(tst.status, tst.text).toBe(201);
    expect(tst.body.ref.id).not.toBe(ndt.body.ref.id);
    expect((await rowsIn<{ id: string }>(db, 'tst', sql`select id from asset where id = ${tst.body.ref.id}`))).toHaveLength(1);
    expect((await rowsIn<{ id: string }>(db, 'ndt', sql`select id from asset where id = ${tst.body.ref.id}`))).toHaveLength(0);
  });
});
