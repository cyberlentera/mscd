// "Own" grants of F.6 outside the transition tables (build plan J.5): every role that holds a permission only for
// its own records calls the route once with a record it owns (admitted: any answer but 403) and once with someone
// else's (403; the file routes answer 404, F.7 `canReadObject`). Create routes count the new record's owner.
import { PERMISSION_MATRIX, routeById, type Permission } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  BUSINESS_ROLE, ROLE_KEYS, addFixtureUser, addRoleUsers, callRoute, createFullApp, inOrg, msIdOf, resetRateLimits, rowsIn, sessionFor,
  type Client, type FixtureUser, type FullApp, type RoleKey, type RouteInput,
} from '../contract/harness';

const ORG = 'tst' as const;
const MS = 'isms';

/** Roles that hold `permission` only for their own records. */
function ownRolesOf(permission: Permission): RoleKey[] {
  const own = PERMISSION_MATRIX[permission].own;
  return ROLE_KEYS.filter((r) => BUSINESS_ROLE[r] && own.includes(BUSINESS_ROLE[r]!));
}

interface OwnCase {
  route: string;
  permission: Permission;
  /** Makes a record owned by `ownerId` (and its handle) and returns the request. */
  prepare(owner: FixtureUser): Promise<RouteInput>;
  /** Status of a refusal (403, or 404 where the plan hides the record). */
  refused?: number;
}

describe('J.5 own grants: an own record and someone else\'s', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let users: Record<RoleKey, FixtureUser>;
  let other: FixtureUser;
  const clients = {} as Record<RoleKey, Client>;
  let msId: string;

  const exec = (query: ReturnType<typeof sql>) => inOrg(db, ORG, async (trx) => void (await query.execute(trx)));
  /** A record of a shareable type linked to the system (round robin). */
  const turn = new Map<string, number>();
  const linked = async (table: string, entityType: string): Promise<string> => {
    const rows = await rowsIn<{ id: string }>(db, ORG, sql`select x.id from ${sql.table(table)} x where x.deleted_at is null and exists (select 1 from entity_ms_link l
      where l.entity_type = ${entityType} and l.entity_id = x.id and l.management_system_id = ${msId} and l.deleted_at is null) order by x.id`);
    if (rows.length === 0) throw new Error(`No ${table} linked to ${MS}`);
    const n = turn.get(table) ?? 0;
    turn.set(table, n + 1);
    return rows[n % rows.length]!.id;
  };
  const evidenceOf = async (): Promise<string> => {
    const rows = await rowsIn<{ id: string }>(db, ORG, sql`select e.id from evidence e where e.deleted_at is null and exists (select 1 from evidence_target t
      where t.evidence_id = e.id and t.management_system_id = ${msId} and t.deleted_at is null) order by e.id`);
    const n = turn.get('evidence') ?? 0;
    turn.set('evidence', n + 1);
    return rows[n % rows.length]!.id;
  };

  const cases: OwnCase[] = [
    {
      route: 'records.complete-action',
      permission: 'record.complete_action',
      prepare: async (owner) => {
        const id = await linked('risk', 'risk');
        await exec(sql`update risk set owner_user_id = ${owner.id}, pending_action = 'Review the treatment options' where id = ${id}`);
        return { params: { ms: MS, entityType: 'risk', id }, body: { note: 'Done by the WP-30 test' } };
      },
    },
    {
      route: 'evidence.update',
      permission: 'evidence.manage',
      prepare: async (owner) => {
        const id = await evidenceOf();
        await exec(sql`update evidence set owner_user_id = ${owner.id}, classification = 'internal' where id = ${id}`);
        return { params: { ms: MS, id }, body: { nextDueOverride: '2026-10-31' } };
      },
    },
    {
      route: 'metrics.values.create',
      permission: 'metric.record',
      prepare: async (owner) => {
        const id = await linked('metric', 'metric');
        await exec(sql`update metric set owner_user_id = ${owner.id} where id = ${id}`);
        return { params: { ms: MS, id }, body: { periodStart: '2026-07-01', periodEnd: '2026-09-30', value: 97.5 } };
      },
    },
    {
      route: 'registers.update',
      permission: 'register.manage',
      prepare: async (owner) => {
        // The demo holds no asset in this system: the MS Manager adds one for the owner.
        const created = await clients.MM.post<{ ref: { id: string } }>(`/api/v1/ms/${MS}/registers/assets`, {
          code: `AS-O${Math.floor(Math.random() * 1e6)}`, title: 'WP-30 asset', ownerHandle: owner.handle, assetType: 'infrastructure', classification: 'internal', linkedMs: [MS],
        });
        if (created.status !== 201) throw new Error(`asset: ${created.status} ${created.text}`);
        return { params: { ms: MS, register: 'assets', id: created.body.ref.id }, body: { title: 'Renamed by the WP-30 test', confirm: true } };
      },
    },
    {
      route: 'registers.update',
      permission: 'risk.manage',
      prepare: async (owner) => {
        const id = await linked('risk', 'risk');
        await exec(sql`update risk set owner_user_id = ${owner.id} where id = ${id}`);
        return { params: { ms: MS, register: 'risks', id }, body: { likelihood: 2, assessedAt: '2026-09-29' } };
      },
    },
    {
      route: 'registers.create',
      permission: 'register.manage',
      prepare: async (owner) => ({
        params: { ms: MS, register: 'assets' },
        body: { code: `AS-W${Math.floor(Math.random() * 1e6)}`, title: 'WP-30 asset', ownerHandle: owner.handle, assetType: 'infrastructure', classification: 'internal', linkedMs: [MS] },
      }),
    },
    {
      route: 'storage.upload-intents.create',
      permission: 'evidence.file.submit',
      prepare: async (owner) => {
        const id = await evidenceOf();
        await exec(sql`update evidence set owner_user_id = ${owner.id}, classification = 'internal' where id = ${id}`);
        return { body: { ms: MS, kind: 'evidence', recordId: id, fileName: 'Evidence.pdf', size: 1024 } };
      },
    },
    {
      route: 'storage.objects.open',
      permission: 'storage.object.read',
      refused: 404,
      prepare: async (owner) => {
        const rows = await rowsIn<{ id: string; object: string }>(db, ORG, sql`select e.id, e.storage_object_id as object from evidence e where e.deleted_at is null
          and e.storage_object_id is not null and exists (select 1 from evidence_target t where t.evidence_id = e.id and t.management_system_id = ${msId} and t.deleted_at is null) order by e.id`);
        const n = turn.get('objects') ?? 0;
        turn.set('objects', n + 1);
        const row = rows[n % rows.length]!;
        await exec(sql`update evidence set owner_user_id = ${owner.id}, classification = 'internal' where id = ${row.id}`);
        return { params: { id: row.object }, query: { ms: MS } };
      },
    },
  ];

  beforeAll(async () => {
    full = await createFullApp(db);
    users = await addRoleUsers(db, ORG, MS);
    for (const role of ROLE_KEYS) clients[role] = await sessionFor(full, users[role].id, ORG);
    other = await addFixtureUser(db, ORG, 'wp30-someone', { business: [{ ms: MS, role: 'domain_owner' }] });
    msId = await msIdOf(db, ORG, MS);
  });

  afterAll(async () => {
    await full?.close();
  });

  for (const c of cases) {
    it(`${c.route} (${c.permission}, own for ${ownRolesOf(c.permission).join(', ')})`, async () => {
      const route = routeById(c.route);
      const roles = ownRolesOf(c.permission);
      expect(roles.length).toBeGreaterThan(0);
      const problems: string[] = [];
      for (const role of roles) {
        await resetRateLimits(db);
        const foreign = await callRoute(clients[role], route, await c.prepare(other));
        if (foreign.status !== (c.refused ?? 403)) problems.push(`${role}, someone else's record: ${foreign.status} ${foreign.text.slice(0, 160)}`);
        const own = await callRoute(clients[role], route, await c.prepare(users[role]));
        if ([403, 404].includes(own.status)) problems.push(`${role}, own record: ${own.status} ${own.text.slice(0, 160)}`);
        problems.push(...foreign.violations, ...own.violations);
      }
      expect(problems).toEqual([]);
    });
  }
});
