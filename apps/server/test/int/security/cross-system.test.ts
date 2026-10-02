// Cross-system records (build plan J.5, D.1, F.7 `RecordResolver`): in an organisation with several systems, every
// route with `{ms}` and a record id answers 404 for a record of another system of the same organisation, even for a
// user who manages both systems; an `{entityType}` outside `RECORD_ENTITY_TYPES` is 404; `POST /reminders` with a
// record of another system is 404.
import { randomBytes } from 'node:crypto';
import { API_ROUTES, RECORD_ENTITY_TYPES, pathParamNames, routeById, type RouteDef } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  callRoute, createFullApp, demoSession, exampleInput, inOrg, msIdOf, resetRateLimits, rowsIn, type Client, type FullApp,
} from '../contract/harness';
import { DIRECT, ID_TABLES } from './record-tables';

const ORG = 'ndt' as const;

/** Routes with `{ms}` and a path parameter that names a record (not `{n}`, `{key}`, `{register}` or `{conditionCode}` alone). */
const RECORD_ROUTES: readonly RouteDef[] = API_ROUTES.filter((r) => {
  const names = pathParamNames(r.path);
  return names.includes('ms') && names.includes('id');
});

describe('J.5 records of another system of the same organisation', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let rina: Client;
  let isms: string;
  let qms: string;

  /** A record of `table` that belongs to QMS and not to ISMS (created when the demo has none). */
  const foreign = new Map<string, string>();
  const foreignRecord = async (table: string): Promise<string> => {
    const known = foreign.get(table);
    if (known) return known;
    let id: string | undefined;
    if (DIRECT.has(table)) {
      id = (await rowsIn<{ id: string }>(db, ORG, sql`select id from ${sql.table(table)} where management_system_id = ${qms} and deleted_at is null order by id limit 1`))[0]?.id;
    } else {
      id = (await rowsIn<{ id: string }>(db, ORG, sql`select x.id from ${sql.table(table)} x where x.deleted_at is null
        and exists (select 1 from entity_ms_link l where l.entity_type = ${table} and l.entity_id = x.id and l.management_system_id = ${qms} and l.deleted_at is null)
        and not exists (select 1 from entity_ms_link l where l.entity_type = ${table} and l.entity_id = x.id and l.management_system_id = ${isms} and l.deleted_at is null)
        ${table === 'evidence' ? sql`and not exists (select 1 from evidence_target t where t.evidence_id = x.id and t.management_system_id = ${isms} and t.deleted_at is null)` : sql``}
        order by x.id limit 1`))[0]?.id;
    }
    id ??= await createForeign(table);
    foreign.set(table, id);
    return id;
  };

  const insertReturning = (query: ReturnType<typeof sql<{ id: string }>>) => inOrg(db, ORG, async (trx) => (await query.execute(trx)).rows[0]!.id);
  const createForeign = async (table: string): Promise<string> => {
    switch (table) {
      case 'corrective_action':
        return insertReturning(sql`insert into corrective_action (management_system_id, code, title, status) values (${qms}, 'CA-WP30-Q', 'QMS action', 'correction') returning id`);
      case 'management_review': {
        const id = await insertReturning(sql`insert into management_review (code, title, status) values ('MR-WP30-Q', 'QMS review', 'planned') returning id`);
        await inOrg(db, ORG, (trx) => sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary) values ('management_review', ${id}, ${qms}, true)`.execute(trx));
        return id;
      }
      case 'self_assessment': {
        // The demo QMS edition has no finding conditions; the resolver reads only the row's system.
        const [condition] = await rowsIn<{ id: string }>(db, ORG, sql`select c.id from ref.finding_condition c order by c.id limit 1`);
        if (!condition) throw new Error('QMS has no finding condition');
        return insertReturning(sql`insert into self_assessment (management_system_id, finding_condition_id, status, owner_user_id) values (${qms}, ${condition.id}, 'gap',
          (select id from platform.app_user where handle = 'sari')) returning id`);
      }
      case 'audit_activity': {
        const event = await foreignRecord('audit_event');
        return insertReturning(sql`insert into audit_activity (audit_event_id, management_system_id, title) values (${event}, ${qms}, 'QMS activity') returning id`);
      }
      case 'evidence_pack':
        return insertReturning(sql`insert into evidence_pack (management_system_id) values (${qms}) returning id`);
      case 'auditor_access_grant':
        return insertReturning(sql`insert into auditor_access_grant (management_system_id, email, token_hash, expires_at)
          values (${qms}, 'qms.auditor@wp30.test', ${randomBytes(32)}, now() + interval '7 days') returning id`);
      default:
        throw new Error(`No QMS-only ${table} in the demo data and no fixture for it`);
    }
  };

  beforeAll(async () => {
    full = await createFullApp(db);
    rina = await demoSession(full, db, 'rina', ORG);
    isms = await msIdOf(db, ORG, 'isms');
    qms = await msIdOf(db, ORG, 'qms');
  });

  afterAll(async () => {
    await full?.close();
  });

  it('maps every route with {ms} and {id} to the table of its record', () => {
    const unmapped = RECORD_ROUTES.filter((r) => !pathParamNames(r.path).includes('entityType') && !ID_TABLES[r.id]).map((r) => r.id);
    expect(unmapped).toEqual([]);
  });

  for (const def of RECORD_ROUTES.filter((r) => !pathParamNames(r.path).includes('entityType'))) {
    it(`${def.id}: a QMS record through the ISMS path is 404 for the manager of both`, async () => {
      await resetRateLimits(db);
      const table = ID_TABLES[def.id]!;
      const id = await foreignRecord(table);
      const ids: Record<string, string> = { id };
      if (def.id === 'evidence.targets.remove') {
        ids.targetId = (await rowsIn<{ id: string }>(db, ORG, sql`select id from evidence_target where evidence_id = ${id} and deleted_at is null limit 1`))[0]?.id ?? id;
      }
      const params: Record<string, string> = { ms: 'isms', ...ids };
      if (def.id === 'registers.update') params.register = 'risks';
      const input = exampleInput(def, { ms: 'isms', ids, override: { params } });
      const reply = await callRoute(rina, def, input);
      expect(reply.status, reply.text.slice(0, 300)).toBe(404);
      expect(reply.violations).toEqual([]);
    });
  }

  describe('{entityType} routes', () => {
    const typed = RECORD_ROUTES.filter((r) => pathParamNames(r.path).includes('entityType'));

    for (const [entityType, table] of [['applicability_entry', 'applicability_entry'], ['document', 'document'], ['evidence', 'evidence'], ['risk', 'risk'],
      ['finding', 'finding'], ['audit_prep_task', 'audit_prep_task'], ['risk_treatment', 'risk_treatment'], ['cycle_requirement_status', 'cycle_requirement_status']] as const) {
      it(`a QMS ${entityType} through the ISMS path is 404 on every {entityType} route`, async () => {
        const id = await foreignRecord(table);
        for (const def of typed) {
          await resetRateLimits(db);
          const reply = await callRoute(rina, def, exampleInput(def, { ms: 'isms', override: { params: { ms: 'isms', entityType, id } } }));
          expect(reply.status, `${def.id}: ${reply.text.slice(0, 200)}`).toBe(404);
          expect(reply.violations).toEqual([]);
        }
      });
    }

    it('an entity type outside RECORD_ENTITY_TYPES is 404 before anything runs', async () => {
      const id = await foreignRecord('risk');
      for (const entityType of ['app_user', 'organization', 'storage_credential', 'audit_trail', 'Document', 'risk;drop']) {
        expect(RECORD_ENTITY_TYPES as readonly string[]).not.toContain(entityType);
        for (const def of typed) {
          const reply = await callRoute(rina, def, exampleInput(def, { ms: 'isms', override: { params: { ms: 'isms', entityType, id } } }));
          expect(reply.status, `${def.id} ${entityType}: ${reply.text.slice(0, 200)}`).toBe(404);
          expect(reply.violations).toEqual([]);
        }
      }
    });
  });

  it('POST /reminders with a record of another system is 404 (by ref and by record key)', async () => {
    const def = routeById('reminders.send');
    const riskId = await foreignRecord('risk');
    const [risk] = await rowsIn<{ code: string }>(db, ORG, sql`select code from risk where id = ${riskId}`);
    const byRef = await callRoute(rina, def, { body: { ms: 'isms', ref: { module: 'audit', entityType: 'risk', id: riskId, code: risk!.code }, recipient: 'bagus' } });
    expect(byRef.status, byRef.text).toBe(404);
    expect(byRef.violations).toEqual([]);
    const byKey = await callRoute(rina, def, { body: { ms: 'isms', recordKey: `qms:x:${risk!.code}`, recipient: 'bagus' } });
    expect([400, 404], byKey.text).toContain(byKey.status);
    // Through its own system the reminder is sent.
    const sent = await callRoute(rina, def, { body: { ms: 'qms', ref: { module: 'audit', entityType: 'risk', id: riskId, code: risk!.code }, recipient: 'sari' } });
    expect(sent.status, sent.text).not.toBe(404);
  });
});
