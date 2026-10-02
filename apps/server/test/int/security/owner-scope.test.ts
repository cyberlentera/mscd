// Owner scope and read projections on every GET route (build plan J.5, D-04, D-34, F.7, G.5, Q-8):
// - a Domain Owner of ISMS who owns nothing gets no record of anyone on any GET route of ISMS, and every route of
//   another system is 403 for them; `/ui/org` shows chains, titles and people of ISMS only;
// - a Domain Owner sees the records they own, and a `restricted` document only when they own it;
// - the guest auditor gets the G.5 projection on every GET route: no holder names, no `web_url`, evidence only
//   through ready evidence packs;
// - Top Management gets pending data as aggregates only: no holder or due date of anyone else's pending work in
//   `GET /ui/ms/{ms}`, with the counts of the full view (WP-30 fix of `ScopePolicyService.projectSnapshot`).
import { API_ROUTES, pathParamNames, type RouteDef, type UiMsSnapshot, type UiOrgSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  addFixtureUser, callRoute, createFullApp, demoSession, exampleInput, msIdOf, resetRateLimits, rowsIn, sessionFor, userIdOf,
  type Client, type FullApp, type FixtureUser, type RouteInput,
} from '../contract/harness';

/** GET routes of a signed-in user that read one system. */
const MS_READS: readonly RouteDef[] = API_ROUTES.filter(
  (r) => r.method === 'GET' && r.auth === 'session' && !r.testOnly && (r.msSource !== undefined || pathParamNames(r.path).includes('ms')),
);
/** GET routes of a signed-in user that name no system. */
const ORG_READS: readonly RouteDef[] = API_ROUTES.filter(
  (r) => r.method === 'GET' && r.auth === 'session' && !r.testOnly && r.msSource === undefined && !pathParamNames(r.path).includes('ms'),
);

/** Every RecordRef (`module`, `entityType`, `id`) in a body. */
function refsIn(body: unknown, out: { entityType: string; id: string; code?: string }[] = []) {
  if (Array.isArray(body)) for (const v of body) refsIn(v, out);
  else if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (typeof o.module === 'string' && typeof o.entityType === 'string' && typeof o.id === 'string') {
      out.push({ entityType: o.entityType, id: o.id, ...(typeof o.code === 'string' ? { code: o.code } : {}) });
    }
    for (const v of Object.values(o)) refsIn(v, out);
  }
  return out;
}

/** Values of keys that name people holding work (`owner`, `holder`, `h`, handles inside `holder` objects). */
function holdersIn(body: unknown, out: string[] = [], key = ''): string[] {
  if (Array.isArray(body)) for (const v of body) holdersIn(v, out, key);
  else if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if ((k === 'owner' || k === 'holder' || k === 'h' || k === 'approver') && typeof v === 'string') out.push(`${k}=${v}`);
      else if (k === 'holder' && v && typeof v === 'object' && typeof (v as { handle?: unknown }).handle === 'string') out.push(`holder=${(v as { handle: string }).handle}`);
      holdersIn(v, out, k);
    }
  }
  return out;
}

/** A valid input of a GET route for a system, with real ids where the route needs one. */
async function readInput(db: ReturnType<typeof useTestDatabase>, def: RouteDef, org: 'ndt' | 'tst', ms: string): Promise<RouteInput | null> {
  const msId = await msIdOf(db, org, ms);
  const names = pathParamNames(def.path);
  const ids: Record<string, string> = {};
  if (names.includes('id')) {
    const table = def.id.startsWith('evidence-packs') ? 'evidence_pack' : 'audit_event';
    const [row] = await rowsIn<{ id: string }>(db, org, sql`select id from ${sql.table(table)} where management_system_id = ${msId} and deleted_at is null limit 1`);
    if (!row) return null;
    ids.id = row.id;
  }
  const override: RouteInput = { params: { ms, ...ids } };
  if (names.includes('n')) override.params!.n = 4;
  if (names.includes('key')) override.params!.key = 'risk';
  if (def.msSource === 'query') override.query = { ms };
  return exampleInput(def, { ms, ids, override });
}

describe('J.5 owner scope and read projections on every GET route', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let nobody: Client;
  let nobodyUser: FixtureUser;
  let rina: Client;

  beforeAll(async () => {
    full = await createFullApp(db);
    nobodyUser = await addFixtureUser(db, 'ndt', 'wp30-do-none', { business: [{ ms: 'isms', role: 'domain_owner' }] });
    nobody = await sessionFor(full, nobodyUser.id, 'ndt');
    rina = await demoSession(full, db, 'rina', 'ndt');
  });

  afterAll(async () => {
    await full?.close();
  });

  it('gives an ISMS Domain Owner who owns nothing no record of anyone on every GET route of ISMS', async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const def of MS_READS) {
      await resetRateLimits(db);
      const input = await readInput(db, def, 'ndt', 'isms');
      if (!input) continue;
      const reply = await callRoute(nobody, def, input);
      problems.push(...reply.violations);
      if (reply.status === 403 || reply.status === 404) continue;
      if (reply.status !== 200) {
        problems.push(`${def.id}: ${reply.status} ${reply.text.slice(0, 160)}`);
        continue;
      }
      checked += 1;
      const refs = refsIn(reply.body).filter((r) => !['management_system', 'audit_event', 'evidence_pack', 'phase'].includes(r.entityType));
      if (refs.length > 0) problems.push(`${def.id}: refs ${refs.slice(0, 5).map((r) => `${r.entityType}:${r.code}`).join(', ')}`);
      const holders = holdersIn(reply.body).filter((h) => !/=(none|wp30-do-none)?$/.test(h));
      if (holders.length > 0) problems.push(`${def.id}: holders ${holders.slice(0, 5).join(', ')}`);
    }
    expect(checked).toBeGreaterThan(15);
    expect(problems).toEqual([]);
  });

  it('refuses an ISMS Domain Owner on every GET route of another system (403)', async () => {
    const problems: string[] = [];
    for (const ms of ['qms', 'abms']) {
      for (const def of MS_READS) {
        await resetRateLimits(db);
        const input = await readInput(db, def, 'ndt', ms);
        if (!input) continue;
        const reply = await callRoute(nobody, def, input);
        if (reply.status !== 403) problems.push(`${ms} ${def.id}: ${reply.status} ${reply.text.slice(0, 120)}`);
        problems.push(...reply.violations);
      }
    }
    expect(problems).toEqual([]);
  });

  it('shows the organisation views of ISMS only: chains, titles, people, tasks and notifications', async () => {
    const qmsCodes = new Set(
      (await rowsIn<{ code: string }>(db, 'ndt', sql`select d.doc_code as code from document d where d.deleted_at is null
        and exists (select 1 from entity_ms_link l join management_system m on m.id = l.management_system_id where l.entity_type = 'document' and l.entity_id = d.id and m.slug = 'qms')
        and not exists (select 1 from entity_ms_link l join management_system m on m.id = l.management_system_id where l.entity_type = 'document' and l.entity_id = d.id and m.slug = 'isms')`)).map((r) => r.code),
    );
    expect(qmsCodes.size).toBeGreaterThan(0);
    const org = await nobody.get<UiOrgSnapshot>('/api/v1/ui/org');
    expect(org.status).toBe(200);
    expect(Object.keys(org.body.CHAINS).filter((ms) => ms !== 'isms')).toEqual([]);
    for (const chains of Object.values(org.body.CHAINS)) expect(chains).toEqual([]);
    for (const code of Object.keys(org.body.TITLES)) expect(qmsCodes.has(code), code).toBe(false);
    expect(Object.keys(org.body.TITLES)).toEqual([]);
    const ismsPeople = new Set(
      (await rowsIn<{ handle: string }>(db, 'ndt', sql`select distinct u.handle from user_ms_role r join platform.app_user u on u.id = r.user_id
        join management_system m on m.id = r.management_system_id where m.slug = 'isms' and r.deleted_at is null and r.approval_status = 'active'`)).map((r) => r.handle),
    );
    for (const handle of Object.keys(org.body.PEOPLE)) expect(handle === 'none' || ismsPeople.has(handle), handle).toBe(true);
    for (const def of ORG_READS) {
      if (pathParamNames(def.path).length > 0) continue;
      const reply = await callRoute(nobody, def, exampleInput(def));
      expect(reply.violations).toEqual([]);
      if (reply.status !== 200) continue;
      const text = JSON.stringify(reply.body);
      for (const code of qmsCodes) expect(text.includes(`"${code}"`), `${def.id} ${code}`).toBe(false);
    }
  });

  it('shows a Domain Owner the records they own, and a restricted document only to its owner', async () => {
    const owner = await addFixtureUser(db, 'ndt', 'wp30-do-owner', { business: [{ ms: 'isms', role: 'domain_owner' }] });
    const client = await sessionFor(full, owner.id, 'ndt');
    const msId = await msIdOf(db, 'ndt', 'isms');
    const [doc] = await rowsIn<{ id: string; code: string }>(db, 'ndt', sql`select d.id, d.doc_code as code from document d join entity_ms_link l on l.entity_type = 'document'
      and l.entity_id = d.id and l.management_system_id = ${msId} and l.deleted_at is null where d.deleted_at is null and not d.is_org_wide order by d.doc_code limit 1`);
    await rowsIn(db, 'ndt', sql`update document set owner_user_id = ${owner.id}, classification = 'restricted' where id = ${doc!.id}`);
    const mine = await client.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    expect(mine.body.bundle.docs.map((d) => d.id)).toEqual([doc!.code]);
    const listed = await client.get<{ items: { id: string }[] }>('/api/v1/ms/isms/documents');
    expect(listed.body.items.map((d) => d.id)).toEqual([doc!.code]);
    // Another Domain Owner, the Internal Auditor and Top Management do not see it; the MS Manager does.
    for (const handle of ['bagus', 'maya', 'hendra']) {
      const other = await demoSession(full, db, handle, 'ndt');
      const snapshot = await other.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
      expect(snapshot.body.bundle.docs.map((d) => d.id), handle).not.toContain(doc!.code);
      const list = await other.get<{ items: { id: string }[] }>('/api/v1/ms/isms/documents?pageSize=200');
      expect(list.body.items.map((d) => d.id), handle).not.toContain(doc!.code);
    }
    expect((await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body.bundle.docs.map((d) => d.id)).toContain(doc!.code);
  });

  it('gives the guest auditor the G.5 projection on every GET route of the audited system', async () => {
    const guestId = await userIdOf(db, 'ext.auditor');
    const [grant] = await rowsIn<{ id: string }>(db, 'tst', sql`select id from auditor_access_grant where user_id = ${guestId} and revoked_at is null`);
    const guest = await sessionFor(full, guestId, 'tst', { authMethod: 'guest', authGrantId: grant!.id });
    const msId = await msIdOf(db, 'tst', 'isms');
    const packEvidence = new Set(
      (await rowsIn<{ code: string }>(db, 'tst', sql`select e.evidence_code as code from evidence_pack_item i join evidence_pack p on p.id = i.evidence_pack_id
        join evidence e on e.id = i.evidence_id where p.management_system_id = ${msId} and p.status = 'ready'`)).map((r) => r.code),
    );
    const allEvidence = (await rowsIn<{ code: string }>(db, 'tst', sql`select evidence_code as code from evidence where deleted_at is null`)).map((r) => r.code);
    const problems: string[] = [];
    let checked = 0;
    for (const def of [...MS_READS, ...ORG_READS.filter((r) => pathParamNames(r.path).length === 0)]) {
      await resetRateLimits(db);
      const input = await readInput(db, def, 'tst', 'isms');
      if (!input) continue;
      const reply = await callRoute(guest, def, input);
      problems.push(...reply.violations);
      if (reply.status !== 200) continue;
      checked += 1;
      const text = JSON.stringify(reply.body);
      if (/"web_?[uU]rl"/.test(text)) problems.push(`${def.id}: web_url sent`);
      const holders = holdersIn(reply.body).filter((h) => !/=(none)?$/.test(h));
      if (holders.length > 0) problems.push(`${def.id}: holders ${holders.slice(0, 5).join(', ')}`);
      for (const code of allEvidence) if (!packEvidence.has(code) && text.includes(`"${code}"`)) problems.push(`${def.id}: evidence ${code} outside ready packs`);
    }
    expect(checked).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  });

  it('gives Top Management pending data as aggregates only in GET /ui/ms/{ms} (Q-8)', async () => {
    const hendra = await demoSession(full, db, 'hendra', 'ndt');
    const top = (await hendra.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
    const manager = (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
    const others = (h: string | null) => h !== null && h !== 'none' && h !== 'hendra';
    // The full view has pending work of other people, so the rule is exercised.
    expect(manager.bundle.chain.items.filter((i) => others(i.h)).length).toBeGreaterThan(10);
    // Same aggregates: the same items, counts and stage totals.
    expect(top.bundle.chain.items.map((i) => i.key)).toEqual(manager.bundle.chain.items.map((i) => i.key));
    expect(top.bundle.chain.recs).toEqual(manager.bundle.chain.recs);
    expect(top.bundle.gates.map((g) => g.id)).toEqual(manager.bundle.gates.map((g) => g.id));
    for (const item of top.bundle.chain.items) {
      if (item.h !== 'hendra') {
        expect(item.h, item.key).toBe('none');
        expect(item.due, item.key).toBeNull();
      }
    }
    for (const gate of top.bundle.gates) if (gate.h !== 'hendra') expect([gate.h, gate.due], gate.id).toEqual(['none', null]);
    for (const [stage, records] of Object.entries(top.X)) for (const x of records) if (x.h !== 'hendra') expect([x.h, x.due], `${stage} ${x.id}`).toEqual(['none', null]);
    for (const row of top.PREP) expect(['none', 'hendra']).toContain(row[1]);
    for (const row of top.CYCLE_ITEMS) expect(['none', 'hendra']).toContain(row[2]);
    for (const pattern of top.DRIFT) for (const row of pattern.rows ?? []) expect(['none', 'hendra']).toContain(row[2]);
    // Top Management's own pending work keeps its holder and date.
    const own = manager.bundle.chain.items.filter((i) => i.h === 'hendra');
    for (const item of own) expect(top.bundle.chain.items.find((i) => i.key === item.key)).toMatchObject({ h: 'hendra', due: item.due });
  });
});
