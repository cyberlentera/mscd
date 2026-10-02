// Generated tests of the C.13 transition tables (build plan J.5, C.13, F.6): every transition row that a person
// performs is called on a record in the row's `from` state, once by a role that may perform it (204 or any answer
// but 403 and 409: business rules may still refuse with 422) and once by a role that may not (403); rows granted
// "own" are also called by each own-scoped role on a record they own (admitted) and on someone else's (403). Rows
// that only the system performs answer 409 to everyone, and the rejections of C.13 answer 422 with their rule.
import {
  MACHINES, effectiveGrant, machinePermissions, routeById, transitionsVia, type MachineEntity, type Permission, type RouteDef, type Transition,
} from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  BUSINESS_ROLE, ORG_ROLE, ROLE_KEYS, addFixtureUser, addRoleUsers, callRoute, createFullApp, inOrg, msIdOf, resetRateLimits, rowsIn, sessionFor,
  type Client, type FixtureUser, type FullApp, type RoleKey, type RouteInput,
} from '../contract/harness';
import { roleHolds } from './expectations';

const ORG = 'tst' as const;
const MS = 'isms';

/** Full or own grant of a permission for a user holding only `role` in the system (F.6). */
function grantOf(role: RoleKey, permission: Permission): 'full' | 'own' | null {
  const g = effectiveGrant(permission, 'single');
  if (role === 'OP') return g.platformRoles.includes('platform_operator') ? 'full' : null;
  const orgRole = ORG_ROLE[role];
  if (orgRole && g.orgRoles.includes(orgRole)) return 'full';
  const business = BUSINESS_ROLE[role];
  if (!business) return null;
  if (g.scope === 'org') return g.anyMsRoles.includes(business) ? 'full' : null;
  if (g.roles.includes(business)) return 'full';
  if (g.own.includes(business)) return 'own';
  return null;
}

/** A role that holds the row's permission (and `allOf`) in full; the least privileged one before the MS Manager. */
function allowedRole(row: Transition): RoleKey {
  const candidates = ROLE_KEYS.filter((r) => r !== 'EA' && grantOf(r, row.permission!) === 'full' && (row.allOf ?? []).every((p) => grantOf(r, p) === 'full'));
  if (candidates.length === 0) throw new Error(`No role holds ${row.permission} in full`);
  return candidates.find((r) => r !== 'MM') ?? candidates[0]!;
}

/**
 * A role that may not perform the row: preferably one the guard admits on the route (it holds the permission of
 * another row of the machine), so the command itself must refuse; otherwise one the guard denies.
 */
function refusedRole(row: Transition, route: RouteDef): RoleKey {
  const others = new Set<Permission>([...(route.permission ? [route.permission] : []), ...machinePermissions(row.entity, row.via ?? null)]);
  // Every row of the same pair on the same route is an alternative (C.13): the refused role holds none of them.
  const pair = transitionsVia(row.entity, row.from, row.to, row.via ?? null).filter((t) => t.permission !== null);
  const holdsRow = (r: RoleKey) => pair.some((t) => grantOf(r, t.permission!) === 'full' || (t.own === true && grantOf(r, t.permission!) === 'own'));
  const admitted = ROLE_KEYS.filter((r) => r !== 'EA' && r !== 'OP' && !holdsRow(r) && [...others].some((p) => roleHolds(r, { permission: p, scope: effectiveGrant(p, 'single').scope })));
  if (admitted.length > 0) return admitted[0]!;
  const denied = ROLE_KEYS.filter((r) => r !== 'EA' && !holdsRow(r));
  return denied[0]!;
}

/** Own-scoped roles of a row marked `own`. */
function ownRoles(row: Transition): RoleKey[] {
  return row.own ? ROLE_KEYS.filter((r) => grantOf(r, row.permission!) === 'own') : [];
}

interface Fixture {
  route: RouteDef;
  /** Puts a record in `from` owned by `ownerId` and returns the request input for a move to `to`. */
  prepare(row: Transition, ownerId: string): Promise<RouteInput>;
}

describe('J.5 C.13 transition rows by role', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let users: Record<RoleKey, FixtureUser>;
  const clients = {} as Record<RoleKey, Client>;
  let other: FixtureUser;
  let msId: string;
  let serial = 0;

  /** The next record of a table in the system, round robin (each row puts the record in its own `from` state first). */
  const turn = new Map<string, number>();
  const nextRecord = async (table: string, extra = sql``): Promise<string> => {
    const rows = await rowsIn<{ id: string }>(db, ORG, sql`select id from ${sql.table(table)} where management_system_id = ${msId} and deleted_at is null ${extra} order by id`);
    if (rows.length === 0) throw new Error(`No ${table} row in ${MS}`);
    const n = turn.get(table) ?? 0;
    turn.set(table, n + 1);
    return rows[n % rows.length]!.id;
  };
  const exec = (query: ReturnType<typeof sql>) => inOrg(db, ORG, async (trx) => void (await query.execute(trx)));
  const requiresBody = (row: Transition, base: Record<string, unknown>) => {
    const body: Record<string, unknown> = { ...base };
    for (const name of row.requires ?? []) {
      if (name === 'effective') body.effective = row.to === 'closed';
      else if (name === 'targetFixAt') body.targetFixAt = '2026-12-01';
      else if (name === 'ownerHandle') body.ownerHandle = 'rina';
      else if (name === 'targetEdition') body.targetEdition = '2022';
      else body[name] = 'Recorded by the WP-30 transition test';
    }
    return body;
  };

  let requirementId: string;
  let fixtures: Partial<Record<MachineEntity, Fixture>>;

  beforeAll(async () => {
    full = await createFullApp(db);
    users = await addRoleUsers(db, ORG, MS);
    for (const role of ROLE_KEYS) clients[role] = await sessionFor(full, users[role].id, ORG);
    other = await addFixtureUser(db, ORG, 'wp30-other', { business: [{ ms: MS, role: 'domain_owner' }] });
    msId = await msIdOf(db, ORG, MS);
    requirementId = (await rowsIn<{ id: string }>(db, ORG, sql`select requirement_id as id from applicability_entry where management_system_id = ${msId} and requirement_id is not null limit 1`))[0]?.id
      ?? (await rowsIn<{ id: string }>(db, ORG, sql`select r.id from ref.requirement r join management_system m on m.framework_version_id = r.framework_version_id where m.id = ${msId} limit 1`))[0]!.id;

    fixtures = {
      'applicability_entry.implementation_status': {
        route: routeById('applicability.transition'),
        prepare: async (row, owner) => {
          const id = await nextRecord('applicability_entry');
          await exec(sql`update applicability_entry set implementation_status = ${row.from}, owner_user_id = ${owner}, is_applicable = ${row.from !== 'not_applicable'},
            exclusion_justification = ${row.from === 'not_applicable' ? 'Not in scope' : null}, completed_by_user_id = null, completed_at = null,
            verified_by_user_id = null, verified_at = null, holds_gate = false where id = ${id}`);
          return { params: { ms: MS, id }, body: requiresBody(row, { to: row.to }) };
        },
      },
      'implementation_activity_progress.status': {
        route: routeById('activity.transition'),
        prepare: async (row, owner) => {
          const id = await nextRecord('implementation_activity_progress');
          await exec(sql`update implementation_activity_progress set status = ${row.from}, owner_user_id = ${owner},
            blocker_gate_item_ref = ${row.from === 'blocked' ? 'A.8.12' : null}, blocker_reason = ${row.from === 'blocked' ? 'Gate item open' : null},
            completed_by_user_id = ${row.from === 'complete' ? other.id : null}, completed_at = ${row.from === 'complete' ? '2026-09-01' : null},
            verified_by_user_id = null, verified_at = null where id = ${id}`);
          return { params: { ms: MS, id }, body: requiresBody(row, { to: row.to }) };
        },
      },
      'document.status': {
        route: routeById('documents.transition'),
        prepare: async (row, owner) => {
          const docs = await rowsIn<{ id: string }>(db, ORG, sql`select d.id from document d where exists (select 1 from entity_ms_link l where l.entity_type = 'document'
            and l.entity_id = d.id and l.management_system_id = ${msId} and l.deleted_at is null) and d.deleted_at is null and not d.is_org_wide order by d.id`);
          const n = turn.get('document') ?? 0;
          turn.set('document', n + 1);
          const doc = docs[n % docs.length]!;
          await exec(sql`update document set status = ${row.from}, owner_user_id = ${owner}, classification = 'internal' where id = ${doc.id}`);
          return { params: { ms: MS, id: doc.id }, body: requiresBody(row, { to: row.to }) };
        },
      },
      'risk_treatment.status': {
        route: routeById('treatments.transition'),
        prepare: async (row, owner) => {
          const id = await nextRecord('risk_treatment');
          const implemented = ['implemented', 'residual_accepted', 'closed'].includes(row.from!);
          await exec(sql`update risk_treatment set status = ${row.from}, owner_user_id = ${owner}, target_type = 'requirement', requirement_id = ${requirementId},
            catalogue_item_id = null, implemented_by_user_id = ${implemented ? other.id : null}, implemented_at = ${implemented ? '2026-09-01' : null} where id = ${id}`);
          return { params: { ms: MS, id }, body: requiresBody(row, { to: row.to }) };
        },
      },
      'finding.status': {
        route: routeById('findings.transition'),
        prepare: async (row, owner) => {
          const id = await nextRecord('finding');
          await exec(sql`update finding set status = ${row.from}, owner_user_id = ${owner}, classification = 'ofi',
            closed_at = ${row.from === 'closed' ? '2026-09-01' : null}, close_note = ${row.from === 'closed' ? 'Closed' : null} where id = ${id}`);
          return { params: { ms: MS, id }, body: requiresBody(row, { to: row.to }) };
        },
      },
      'corrective_action.status': {
        route: routeById('corrective-actions.transition'),
        prepare: async (row, owner) => {
          const code = `CA-WP30-${(serial += 1)}`;
          const verification = row.from === 'effectiveness_verification';
          const [created] = await inOrg(db, ORG, async (trx) =>
            (await sql<{ id: string }>`insert into corrective_action (management_system_id, code, title, owner_user_id, status, correction_text, rca_text, systemic_check_text,
              action_text, implemented_by_user_id, implemented_at) values (${msId}, ${code}, 'WP-30 fixture action', ${owner}, ${row.from}, 'c', 'r', 's', 'a',
              ${verification ? owner : null}, ${verification ? '2026-09-01' : null}) returning id`.execute(trx)).rows,
          );
          return { params: { ms: MS, id: created!.id }, body: requiresBody(row, { to: row.to }) };
        },
      },
      'management_review.status': {
        route: routeById('management-reviews.transition'),
        prepare: async (row, owner) => {
          const code = `MR-WP30-${(serial += 1)}`;
          const created = await clients.MM.post<{ ref?: { id: string } }>(`/api/v1/ms/${MS}/management-reviews`, {
            code, title: 'WP-30 fixture review', plannedAt: '2026-10-27', ownerHandle: 'rina', linkedMs: [MS],
          });
          if (created.status !== 201) throw new Error(`management review: ${created.status} ${created.text}`);
          const id = created.body.ref!.id;
          await exec(sql`update management_review set status = ${row.from}, owner_user_id = ${owner}, held_at = ${row.from === 'planned' ? null : '2026-09-20'} where id = ${id}`);
          const body = requiresBody(row, { to: row.to });
          if (row.to === 'held') body.heldAt = '2026-09-28';
          if (row.to === 'closed') body.decisionsText = 'Decisions recorded by the WP-30 transition test';
          return { params: { ms: MS, id }, body };
        },
      },
      'audit_prep_task.status': {
        route: routeById('prep-tasks.update'),
        prepare: async (row, owner) => {
          const id = await nextRecord('audit_prep_task');
          await exec(sql`update audit_prep_task set status = ${row.from}, owner_user_id = ${owner}, note = ${row.from === 'blocked' ? 'Blocked' : null} where id = ${id}`);
          return { params: { ms: MS, id }, body: requiresBody(row, { status: row.to }) };
        },
      },
      'cycle_requirement_status.status': {
        route: routeById('cycle-items.update'),
        prepare: async (row, owner) => {
          const id = await nextRecord('cycle_requirement_status');
          await exec(sql`update cycle_requirement_status set status = ${row.from}, owner_user_id = ${owner} where id = ${id}`);
          return { params: { ms: MS, id }, body: requiresBody(row, { status: row.to }) };
        },
      },
      'self_assessment.status': {
        route: routeById('self-assessments.update'),
        prepare: async (row, owner) => {
          const conditions = await rowsIn<{ id: string; code: string }>(db, ORG, sql`select c.id, c.code from ref.finding_condition c
            join management_system m on m.framework_version_id = c.framework_version_id where m.id = ${msId} order by c.code`);
          const n = turn.get('condition') ?? 0;
          turn.set('condition', n + 1);
          const condition = conditions[n % conditions.length]!;
          await exec(sql`delete from self_assessment where finding_condition_id = ${condition.id} and management_system_id = ${msId}`);
          if (row.from !== null) {
            await exec(sql`insert into self_assessment (management_system_id, finding_condition_id, status, owner_user_id, target_fix_at)
              values (${msId}, ${condition.id}, ${row.from}, ${owner}, ${row.from === 'gap' ? '2026-12-01' : null})`);
          }
          return { params: { ms: MS, conditionCode: condition.code }, body: requiresBody(row, { status: row.to, evidenceCodes: [] }) };
        },
      },
    };
  });

  afterAll(async () => {
    await full?.close();
  });

  const call = async (role: RoleKey, route: RouteDef, input: RouteInput) => {
    await resetRateLimits(db);
    return callRoute(clients[role], route, input);
  };

  for (const entity of Object.keys(MACHINES) as MachineEntity[]) {
    const machine = MACHINES[entity];
    const userRows = machine.transitions.filter((t) => t.permission !== null && !t.via && (t.from !== null || entity === 'self_assessment.status'));
    // Role approvals and management system states are performed by dedicated routes, tested below.
    if (userRows.length === 0 || entity === 'user_ms_role.approval_status' || entity === 'management_system.status') continue;
    describe(entity, () => {
      for (const row of userRows) {
        it(`${row.from} -> ${row.to} (${row.permission}${row.own ? ', own' : ''})`, async () => {
          const fixture = fixtures[entity];
          if (!fixture) return expect.fail(`no fixture for ${entity}`);
          const problems: string[] = [];
          const refused = refusedRole(row, fixture.route);
          const denied = await call(refused, fixture.route, await fixture.prepare(row, other.id));
          if (denied.status !== 403) problems.push(`${refused} (may not) answered ${denied.status}: ${denied.text.slice(0, 200)}`);
          for (const role of ownRoles(row)) {
            const foreign = await call(role, fixture.route, await fixture.prepare(row, other.id));
            if (foreign.status !== 403) problems.push(`${role} on someone else's record answered ${foreign.status}: ${foreign.text.slice(0, 200)}`);
            const own = await call(role, fixture.route, await fixture.prepare(row, users[role].id));
            if ([403, 409].includes(own.status)) problems.push(`${role} on an own record answered ${own.status}: ${own.text.slice(0, 200)}`);
            problems.push(...own.violations, ...foreign.violations);
          }
          const allowed = allowedRole(row);
          const done = await call(allowed, fixture.route, await fixture.prepare(row, other.id));
          if ([403, 409].includes(done.status)) problems.push(`${allowed} (may) answered ${done.status}: ${done.text.slice(0, 200)}`);
          problems.push(...denied.violations, ...done.violations);
          expect(problems).toEqual([]);
        });
      }
    });
  }

  describe('rows only the system performs and the rejections of C.13', () => {
    it('answers 409 to the MS Manager for every system-only pair of a transition route', async () => {
      const problems: string[] = [];
      for (const entity of Object.keys(fixtures) as MachineEntity[]) {
        const machine = MACHINES[entity];
        for (const row of machine.transitions.filter((t) => t.permission === null && t.from !== null)) {
          if (machine.transitions.some((t) => t.permission !== null && !t.via && t.from === row.from && t.to === row.to)) continue;
          const fixture = fixtures[entity]!;
          const reply = await call('MM', fixture.route, await fixture.prepare(row, other.id));
          // 409 transition-not-allowed, or 400 when the route's schema does not even name the target (document `expired`).
          if (reply.status !== 409 && reply.status !== 400) problems.push(`${entity} ${row.from} -> ${row.to}: ${reply.status} ${reply.text.slice(0, 160)}`);
          problems.push(...reply.violations);
        }
      }
      expect(problems).toEqual([]);
    });

    it('answers 422 with the rule of each rejection of a transition route', async () => {
      const problems: string[] = [];
      for (const entity of Object.keys(fixtures) as MachineEntity[]) {
        for (const rejection of MACHINES[entity].rejections.filter((r) => !r.via)) {
          const fixture = fixtures[entity]!;
          const row = { entity, from: rejection.from, to: rejection.to, permission: null, rules: [], sets: [] } as Transition;
          const reply = await call('MM', fixture.route, await fixture.prepare(row, other.id));
          const rule = (reply.body as { rule?: string } | undefined)?.rule;
          if (reply.status !== 422 || rule !== rejection.rule) problems.push(`${entity} ${rejection.from} -> ${rejection.to}: ${reply.status} ${rule}`);
        }
      }
      expect(problems).toEqual([]);
    });
  });

  describe('rows of dedicated routes and creation rows', () => {
    it('risks.residual-acceptance (implemented -> residual_accepted): the risk owner only, 422 BR-04 before implementation', async () => {
      const residual = routeById('risks.residual-acceptance');
      const prepare = async (status: string, riskOwner: string) => {
        const [treatment] = await rowsIn<{ id: string; risk_id: string }>(db, ORG, sql`select id, risk_id from risk_treatment
          where management_system_id = ${msId} and risk_id is not null and deleted_at is null order by id desc limit 1`);
        const implemented = status === 'implemented';
        await exec(sql`update risk_treatment set status = ${status}, target_type = 'requirement', requirement_id = ${requirementId}, catalogue_item_id = null,
          implemented_by_user_id = ${implemented ? other.id : null}, implemented_at = ${implemented ? '2026-09-01' : null}, owner_user_id = ${other.id} where id = ${treatment!.id}`);
        await exec(sql`update risk set owner_user_id = ${riskOwner} where id = ${treatment!.risk_id}`);
        return { params: { ms: MS, id: treatment!.risk_id }, body: { treatmentId: treatment!.id, residualLikelihood: 1, residualConsequence: 2, note: 'Accepted by the WP-30 test' } };
      };
      const problems: string[] = [];
      for (const role of ['MM', 'PO', 'DO', 'RO'] as RoleKey[]) {
        const foreign = await call(role, residual, await prepare('implemented', other.id));
        if (foreign.status !== 403) problems.push(`${role} on another owner's risk: ${foreign.status} ${foreign.text.slice(0, 160)}`);
        const own = await call(role, residual, await prepare('implemented', users[role].id));
        if (own.status !== (residual.status ?? 200)) problems.push(`${role} on an own risk: ${own.status} ${own.text.slice(0, 160)}`);
      }
      for (const role of ['IA', 'TM', 'CI', 'TA'] as RoleKey[]) {
        const refused = await call(role, residual, await prepare('implemented', users[role].id));
        if (refused.status !== 403) problems.push(`${role}: ${refused.status}`);
      }
      const early = await call('RO', residual, await prepare('in_progress', users.RO.id));
      if (early.status !== 422 || (early.body as { rule?: string }).rule !== 'BR-04') problems.push(`not implemented: ${early.status} ${early.text.slice(0, 160)}`);
      expect(problems).toEqual([]);
    });

    it('documents.versions (a new version puts the document in review): owner Domain Owner and MS Manager pass the checks, others 403', async () => {
      const versions = routeById('documents.versions');
      const prepare = async (owner: string) => {
        const [doc] = await rowsIn<{ id: string }>(db, ORG, sql`select d.id from document d join entity_ms_link l on l.entity_type = 'document' and l.entity_id = d.id
          and l.management_system_id = ${msId} and l.deleted_at is null where d.deleted_at is null and d.status = 'approved' and not d.is_org_wide order by d.id limit 1`);
        await exec(sql`update document set owner_user_id = ${owner} where id = ${doc!.id}`);
        return { params: { ms: MS, id: doc!.id }, body: { source: 'link', repository: 'sp', externalItemId: 'wp30-missing-item' } };
      };
      const problems: string[] = [];
      // No storage gateway runs here: an admitted call fails later (404 for a repository of another system, 502 or 503).
      for (const [role, owner, admitted] of [['MM', other.id, true], ['DO', users.DO.id, true], ['DO', other.id, false], ['PO', other.id, false], ['IA', other.id, false]] as const) {
        const reply = await call(role, versions, await prepare(owner));
        if (admitted && reply.status === 403) problems.push(`${role} (admitted) answered 403: ${reply.text.slice(0, 160)}`);
        if (!admitted && reply.status !== 403) problems.push(`${role} (refused) answered ${reply.status}`);
      }
      expect(problems).toEqual([]);
    });

    it('management systems: creation (ms.admin and pack.activate) and the admin status changes (ms.admin) by the Tenant Admin only', async () => {
      const create = routeById('admin.ms.create');
      const update = routeById('admin.ms.update');
      const [repo] = await rowsIn<{ slug: string }>(db, ORG, sql`select slug from storage_repository where adapter = 'managed_vault' and deleted_at is null limit 1`);
      const body = {
        slug: 'wpms', code: 'WP30', name: 'WP-30 management system', packId: 'ISO27001-2022', edition: '2022', scopeStatement: 'Test scope',
        defaultRepository: repo!.slug, color: '#1f7a48',
      };
      for (const role of ['MM', 'SA', 'OP'] as RoleKey[]) expect((await call(role, create, { body })).status, role).toBe(403);
      const created = await call('TA', create, { body });
      expect(created.status, created.text).toBe(201);
      expect(created.violations).toEqual([]);
      const id = (created.body as { id: string }).id;
      for (const role of ['MM', 'SA'] as RoleKey[]) expect((await call(role, update, { params: { id }, body: { status: 'implementing' } })).status, role).toBe(403);
      // A system needs an MS Manager before it starts implementing (WP-12 rule).
      await exec(sql`insert into user_ms_role (user_id, management_system_id, role, approval_status) values (${users.MM.id}, ${id}, 'ms_manager', 'active')`);
      const implementing = await call('TA', update, { params: { id }, body: { status: 'implementing' } });
      expect(implementing.status, implementing.text).toBe(200);
      const archived = await call('TA', update, { params: { id }, body: { status: 'archived' } });
      expect(archived.status, archived.text).toBe(200);
    });

    it('ms.transition: the MS Manager may move a certified system to transitioning and back, others 403; implementing -> certified is the system only', async () => {
      const route = routeById('ms.transition');
      await exec(sql`update management_system set status = 'certified', transition_target_version_id = null where id = ${msId}`);
      for (const role of ['PO', 'TA', 'IA'] as RoleKey[]) expect((await call(role, route, { params: { ms: MS }, body: { to: 'transitioning', targetEdition: '2022' } })).status, role).toBe(403);
      const moved = await call('MM', route, { params: { ms: MS }, body: { to: 'transitioning', targetEdition: '2022' } });
      expect([403, 409]).not.toContain(moved.status);
      await exec(sql`update management_system set status = 'implementing', transition_target_version_id = null where id = ${msId}`);
      expect((await call('MM', route, { params: { ms: MS }, body: { to: 'certified' } })).status).toBe(409);
      await exec(sql`update management_system set status = 'certified', transition_target_version_id = null where id = ${msId}`);
    });

    it('role grant approval (pending_approval -> active or rejected): a Tenant Admin other than the requester and the grantee', async () => {
      const approve = routeById('admin.roles.approve');
      const reject = routeById('admin.roles.reject');
      const secondAdmin = await addFixtureUser(db, ORG, 'wp30-ta2', { org: ['tenant_admin'] });
      const second = await sessionFor(full, secondAdmin.id, ORG);
      const pending = async (requestedBy: string) => {
        const [row] = await inOrg(db, ORG, async (trx) =>
          (await sql<{ id: string }>`insert into user_ms_role (user_id, management_system_id, role, approval_status, requested_by)
            values (${other.id}, ${msId}, 'internal_auditor', 'pending_approval', ${requestedBy}) returning id`.execute(trx)).rows,
        );
        return row!.id;
      };
      for (const [route, label] of [[approve, 'approve'], [reject, 'reject']] as const) {
        const id = await pending(users.TA.id);
        for (const role of ['MM', 'SA', 'OP'] as RoleKey[]) expect((await call(role, route, { params: { id: msId, roleId: id } })).status, `${label} ${role}`).toBe(403);
        const self = await call('TA', route, { params: { id: msId, roleId: id } });
        expect(self.status, `${label} by the requester`).toBe(422);
        await resetRateLimits(db);
        const decided = await callRoute(second, route, { params: { id: msId, roleId: id } });
        expect(decided.status, decided.text).toBe(200);
        expect(decided.violations).toEqual([]);
        await exec(sql`update user_ms_role set deleted_at = now() where id = ${id}`);
      }
    });

    it('creation rows: applicability entries (applicability.manage) and first self-assessments (self_assessment.manage)', async () => {
      const create = routeById('applicability.create');
      const [item] = await rowsIn<{ code: string }>(db, ORG, sql`select c.item_code as code from ref.catalogue_item c join management_system m on m.framework_version_id = c.framework_version_id
        where m.id = ${msId} and not exists (select 1 from applicability_entry e where e.catalogue_item_id = c.id and e.management_system_id = m.id and e.deleted_at is null) limit 1`);
      const body = item
        ? { targetType: 'catalogue_item', code: item.code, isApplicable: false, exclusionJustification: 'Not in scope of the WP-30 test', ownerHandle: 'rina', frequencyCode: 'quarterly' }
        : { targetType: 'catalogue_item', code: 'A.5.7', isApplicable: true, inclusionJustification: 'WP-30', ownerHandle: 'rina', frequencyCode: 'quarterly' };
      for (const role of ['PO', 'DO', 'RO', 'IA', 'TA'] as RoleKey[]) expect((await call(role, create, { params: { ms: MS }, body })).status, role).toBe(403);
      const made = await call('MM', create, { params: { ms: MS }, body });
      expect([403, 409].includes(made.status) && item !== undefined, made.text).toBe(false);
      const sa = fixtures['self_assessment.status']!;
      const row = MACHINES['self_assessment.status'].transitions.find((t) => t.from === null && t.to === 'conforming')!;
      expect((await call('DO', sa.route, await sa.prepare(row, other.id))).status).toBe(403);
      const first = await call('IA', sa.route, await sa.prepare(row, other.id));
      expect(first.status, first.text).toBe(200);
    });
  });
});
