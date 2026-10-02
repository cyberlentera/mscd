// External auditor and Top Management rules of the RBAC suite (build plan J.5, F.6, F.7, F.14, D-34): the seeded
// guest auditor of `tst` is refused (403) on every non-GET business route and on `GET /admin/audit-trail/verify` and
// `/anchors` (F.7: no system named), every request it makes adds one `auditor.read` entry with the route id and the
// record refs returned, its reads stop after `valid_until` and after the grant is revoked; Top Management gets 403
// on the storage object routes; a 403 writes `authz.denied` with the route and the system.
import { API_ROUTES, routeById, type RouteDef } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  addFixtureUser, callRoute, createFullApp, demoSession, exampleInput, inOrg, msIdOf, resetRateLimits, rowsIn, sessionFor, userIdOf,
  type Client, type FullApp,
} from '../contract/harness';
import { isBusinessRoute } from './expectations';

const ORG = 'tst' as const;

interface AuditRow {
  seq: string;
  action: string;
  entity_code: string | null;
  management_system_id: string | null;
  after_data: Record<string, unknown> | null;
}

describe('J.5 external auditors and Top Management', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let guest: Client;
  let guestId: string;
  let grantId: string;
  let msId: string;

  const auditSince = async (seq: string, action?: string): Promise<AuditRow[]> =>
    rowsIn<AuditRow>(db, ORG, sql`select seq::text, action, entity_code, management_system_id, after_data from audit_trail
      where seq > ${seq}::bigint and (${action ?? null}::text is null or action = ${action ?? null}) order by seq`);
  const lastSeq = async (): Promise<string> => (await rowsIn<{ seq: string }>(db, ORG, sql`select coalesce(max(seq), 0)::text as seq from audit_trail`))[0]!.seq;

  beforeAll(async () => {
    full = await createFullApp(db);
    guestId = await userIdOf(db, 'ext.auditor');
    msId = await msIdOf(db, ORG, 'isms');
    grantId = (await rowsIn<{ id: string }>(db, ORG, sql`select id from auditor_access_grant where user_id = ${guestId} and revoked_at is null`))[0]!.id;
    guest = await sessionFor(full, guestId, ORG, { authMethod: 'guest', authGrantId: grantId });
  });

  afterAll(async () => {
    await full?.close();
  });

  it('refuses the guest auditor on every non-GET business route with 403 and an authz.denied entry', async () => {
    const writes = API_ROUTES.filter((r) => r.auth === 'session' && r.method !== 'GET' && isBusinessRoute(r) && !r.testOnly);
    expect(writes.length).toBeGreaterThan(80);
    const problems: string[] = [];
    const before = await lastSeq();
    for (const def of writes) {
      await resetRateLimits(db);
      const reply = await callRoute(guest, def, exampleInput(def, { ms: 'isms' }));
      if (reply.status !== 403) problems.push(`${def.id}: ${reply.status} ${reply.text.slice(0, 120)}`);
      problems.push(...reply.violations);
    }
    expect(problems).toEqual([]);
    const denied = await auditSince(before, 'authz.denied');
    expect(new Set(denied.map((d) => d.entity_code))).toEqual(new Set(writes.map((w) => w.id)));
    // Nothing else was written: the guest changed nothing.
    expect((await auditSince(before)).filter((a) => a.action !== 'authz.denied')).toEqual([]);
  });

  it('refuses the guest auditor on the audit chain verification and the anchors (no system named, F.7)', async () => {
    for (const id of ['audit-trail.verify', 'audit-trail.anchors']) {
      const def = routeById(id);
      const reply = await callRoute(guest, def, exampleInput(def));
      expect(reply.status, id).toBe(403);
    }
    // The audit trail of the audited system stays readable (time-boxed audit_trail.read).
    const list = routeById('audit-trail.list');
    const reply = await callRoute(guest, list, { query: { ms: 'isms' } });
    expect(reply.status, reply.text).toBe(200);
    expect(reply.violations).toEqual([]);
  });

  it('writes one auditor.read entry per request with the route id and the record refs returned', async () => {
    const reads: { def: RouteDef; url: string }[] = [
      { def: routeById('ui.ms'), url: '/api/v1/ui/ms/isms' },
      { def: routeById('ui.org'), url: '/api/v1/ui/org' },
      { def: routeById('readmodel.applicability.list'), url: '/api/v1/ms/isms/applicability?pageSize=5' },
      { def: routeById('readmodel.documents.list'), url: '/api/v1/ms/isms/documents' },
      { def: routeById('findings.list'), url: '/api/v1/ms/isms/findings' },
      { def: routeById('evidence-packs.list'), url: '/api/v1/ms/isms/evidence-packs' },
      { def: routeById('ui.tasks'), url: '/api/v1/tasks' },
    ];
    for (const { url } of reads) {
      const before = await lastSeq();
      const reply = await guest.get(url);
      expect(reply.status, `${url}: ${reply.text.slice(0, 200)}`).toBe(200);
      const entries = await auditSince(before, 'auditor.read');
      expect(entries, url).toHaveLength(1);
      const entry = entries[0]!;
      const after = entry.after_data as { routeId: string; refCount: number; refs: { entityType: string; id: string; entityCode: string }[] };
      const route = reads.find((r) => r.url === url)!.def;
      expect(after.routeId).toBe(route.id);
      expect(entry.entity_code).toBe(route.id);
      // Every RecordRef of the answer is listed (G.5 projection: the refs the auditor received).
      const returned = JSON.stringify(reply.body);
      for (const ref of after.refs) expect(returned, `${url} ${ref.entityCode}`).toContain(ref.id);
      if (url.startsWith('/api/v1/ms/isms/applicability')) expect(after.refCount).toBeGreaterThan(0);
      if (url !== '/api/v1/ui/org' && url !== '/api/v1/tasks') expect(entry.management_system_id).toBe(msId);
    }
  });

  it('stops reads of an external auditor role after valid_until (403)', async () => {
    const auditor = await addFixtureUser(db, ORG, 'wp30-ea-expiring', { business: [{ ms: 'isms', role: 'external_auditor' }] });
    const client = await sessionFor(full, auditor.id, ORG);
    expect((await client.get('/api/v1/ui/ms/isms')).status).toBe(200);
    await inOrg(db, ORG, (trx) => sql`update user_ms_role set valid_until = now() - interval '1 minute' where user_id = ${auditor.id}`.execute(trx));
    const after = await client.get('/api/v1/ui/ms/isms');
    expect(after.status, after.text).toBe(403);
    expect((await client.get('/api/v1/ms/isms/findings')).status).toBe(403);
  });

  it('stops every read of the guest after the grant is revoked', async () => {
    const rina = await demoSession(full, db, 'rina', ORG);
    expect((await guest.get('/api/v1/ui/ms/isms')).status).toBe(200);
    const revoked = await rina.post(`/api/v1/ms/isms/auditor-access/${grantId}/revoke`, {});
    expect(revoked.status, revoked.text).toBe(200);
    // The guest's sessions end with the grant (F.14 step 5).
    expect((await guest.get('/api/v1/ui/ms/isms')).status).toBe(401);
    // A session that would still name the grant gets nothing either: the role ended and the membership is disabled.
    const late = await sessionFor(full, guestId, ORG, { authMethod: 'guest', authGrantId: grantId });
    for (const url of ['/api/v1/ui/ms/isms', '/api/v1/ms/isms/findings', '/api/v1/admin/audit-trail?ms=isms']) {
      const reply = await late.get(url);
      expect([401, 403], `${url}: ${reply.status}`).toContain(reply.status);
    }
  });

  it('refuses Top Management on the storage object routes (403) and writes authz.denied with the route and the system', async () => {
    const hendra = await demoSession(full, db, 'hendra', ORG);
    const [object] = await rowsIn<{ id: string }>(db, ORG, sql`select e.storage_object_id as id from evidence e
      join evidence_target t on t.evidence_id = e.id and t.management_system_id = ${msId} and t.deleted_at is null
      where e.storage_object_id is not null and e.deleted_at is null limit 1`);
    expect(object).toBeDefined();
    const before = await lastSeq();
    for (const id of ['storage.objects.open', 'storage.objects.content']) {
      const def = routeById(id);
      const reply = await callRoute(hendra, def, { params: { id: object!.id }, query: { ms: 'isms' } });
      expect(reply.status, `${id}: ${reply.text.slice(0, 160)}`).toBe(403);
      expect(reply.violations).toEqual([]);
    }
    const denied = await auditSince(before, 'authz.denied');
    expect(denied.map((d) => d.entity_code).sort()).toEqual(['storage.objects.content', 'storage.objects.open']);
    for (const entry of denied) {
      expect(entry.management_system_id).toBe(msId);
      expect(entry.after_data).toMatchObject({ routeId: entry.entity_code, ms: 'isms' });
    }
    // The redirect route needs a token the open route issues; Top Management never gets one.
    const redirect = await hendra.get(`/api/v1/storage/objects/${object!.id}/redirect?t=forged`);
    expect([400, 403, 404]).toContain(redirect.status);
  });

  it('writes at most one authz.denied entry per user, route and minute', async () => {
    const owner = await demoSession(full, db, 'bagus', ORG);
    const before = await lastSeq();
    for (let i = 0; i < 5; i += 1) expect((await owner.post('/api/v1/ms/isms/phases/1/verify', {})).status).toBe(403);
    expect(await auditSince(before, 'authz.denied')).toHaveLength(1);
  });
});
