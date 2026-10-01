// Role resolution and the role-based permission evaluator (build plan F.6, F.7) against PostgreSQL: every row of the
// F.6 matrix once, for a user holding each role, compared with a table transcribed from the plan (not computed from
// the shared matrix); organisation roles in ms-scoped rows; only active grants count; external auditors only in the
// audited system; and `GET /me` with the permissions of a fixture organisation.
import { Me, PERMISSIONS, type BusinessRole, type Permission } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../../src/common/problems';
import { PERMISSION_EVALUATOR, type Principal } from '../../../src/common/tokens';
import { RolePermissionEvaluator } from '../../../src/modules/authz/permission-evaluator';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { addOrg, addUser, createAuthzApp, grantRole, principalOf, sessionFor, type AuthzApp, type Org, type User } from './helpers';

type Column = 'MM' | 'PO' | 'DO' | 'RO' | 'IA' | 'TM' | 'EA' | 'CI' | 'TA' | 'SA' | 'OP';
type Cell = 'full' | 'own';

/**
 * F.6 as written in the plan: per permission, the columns that hold it (`full`, or `own` for "own" cells). The
 * "MM of any system" cells are full grants at organisation scope for a user holding the role in one system.
 */
const F6: Record<Permission, Partial<Record<Column, Cell>>> = {
  'ms.read': { MM: 'full', PO: 'full', DO: 'own', RO: 'own', IA: 'full', TM: 'full', EA: 'full', CI: 'own' },
  'applicability.complete': { MM: 'full', DO: 'own', RO: 'own' },
  'applicability.verify': { MM: 'full', PO: 'full' },
  'applicability.manage': { MM: 'full' },
  'activity.transition': { MM: 'full', DO: 'own', RO: 'own' },
  'activity.verify': { MM: 'full', PO: 'full' },
  'phase.verify': { MM: 'full' },
  'record.assign': { MM: 'full', PO: 'full' },
  'record.complete_action': { MM: 'full', DO: 'own', RO: 'own', CI: 'own' },
  'record.delete': { MM: 'full' },
  'document.review': { MM: 'full', DO: 'own' },
  'document.approve': { MM: 'full', PO: 'full' },
  'document.manage': { MM: 'full' },
  'document.version.create': { MM: 'full', DO: 'own' },
  'evidence.file.submit': { MM: 'full', DO: 'own', RO: 'own' },
  'evidence.manage': { MM: 'full', DO: 'own', RO: 'own' },
  'register.manage': { MM: 'full', DO: 'own', RO: 'own' },
  'metric.record': { MM: 'full', DO: 'own', RO: 'own' },
  'risk.manage': { MM: 'full', RO: 'own' },
  'risk.treatment.update': { MM: 'full', DO: 'own', RO: 'own' },
  'risk.residual.accept': { MM: 'own', PO: 'own', DO: 'own', RO: 'own' },
  'entity_link.manage': { MM: 'full' },
  'ms.transition': { MM: 'full' },
  'reminder.send': { MM: 'full', PO: 'full', IA: 'full' },
  'audit.pending.all': { MM: 'full', PO: 'full' },
  'audit.pending.aggregate': { MM: 'full', PO: 'full', TM: 'full' },
  'audit_event.manage': { MM: 'full' },
  'prep_task.update': { MM: 'full', DO: 'own', IA: 'own' },
  'cycle_item.update': { MM: 'full', DO: 'own', IA: 'own' },
  'finding.raise': { MM: 'full', IA: 'full' },
  'finding.manage': { MM: 'full' },
  'corrective_action.manage': { MM: 'full' },
  'corrective_action.update': { MM: 'full', DO: 'own', RO: 'own' },
  'corrective_action.verify': { MM: 'full', PO: 'full', IA: 'full' },
  'self_assessment.manage': { MM: 'full', IA: 'full' },
  'management_review.manage': { MM: 'full', PO: 'full' },
  'evidence_pack.build': { MM: 'full', IA: 'full' },
  'auditor_access.grant': { MM: 'full' },
  'export.run': { MM: 'full', PO: 'full', IA: 'full', TM: 'full' },
  'link_health.run': { MM: 'full', SA: 'full' },
  'storage.move.request': { MM: 'full' },
  'storage.object.read': { MM: 'full', PO: 'full', DO: 'own', RO: 'own', IA: 'full', EA: 'full', CI: 'own' },
  'audit_trail.read': { MM: 'full', EA: 'full' },
  'storage.repository.read': { MM: 'full', TA: 'full', SA: 'full' },
  'storage.repository.manage': { TA: 'full', SA: 'full' },
  'storage.repository.test': { TA: 'full', SA: 'full' },
  'storage.routing.manage': { TA: 'full', SA: 'full' },
  'storage.object.metadata.read': { TA: 'full', SA: 'full' },
  'pack.read': { MM: 'full', IA: 'full', TA: 'full' },
  'pack.activate': { TA: 'full' },
  'pack.install': { TA: 'full' },
  'license.read': { TM: 'full', TA: 'full' },
  'license.manage': { TA: 'full' },
  'user.manage': { TA: 'full' },
  'idp.manage': { TA: 'full' },
  'org.settings.manage': { TA: 'full' },
  'ms.admin': { TA: 'full' },
  'audit_trail.metadata.read': { TA: 'full' },
  'ops.read': { OP: 'full' },
  'ops.jobs.run': { OP: 'full' },
  'ops.users.manage': { OP: 'full' },
};

/** Where each permission is checked with `tenancy.mode: single` (the test profile). */
const ORG_SCOPED = new Set<Permission>([
  'storage.repository.read', 'storage.repository.manage', 'storage.repository.test', 'storage.routing.manage', 'storage.object.metadata.read',
  'pack.read', 'pack.activate', 'pack.install', 'license.read', 'license.manage', 'user.manage', 'idp.manage', 'org.settings.manage', 'ms.admin',
  'audit_trail.metadata.read',
]);
const PLATFORM_SCOPED = new Set<Permission>(['ops.read', 'ops.jobs.run', 'ops.users.manage']);

const BUSINESS: Record<Exclude<Column, 'TA' | 'SA' | 'OP'>, BusinessRole> = {
  MM: 'ms_manager',
  PO: 'programme_owner',
  DO: 'domain_owner',
  RO: 'risk_owner',
  IA: 'internal_auditor',
  TM: 'top_management',
  EA: 'external_auditor',
  CI: 'compliance_investigator',
};

describe('WP-39 role resolution and permission evaluator (F.6, F.7)', () => {
  const db = useTestDatabase('empty');
  let ctx: AuthzApp;
  let ndt: Org;
  let bsd: Org;
  let evaluator: RolePermissionEvaluator;
  const users: Partial<Record<Column, User>> = {};
  let multi: User;

  beforeAll(async () => {
    ndt = await addOrg(db, 'ndt', ['isms', 'qms']);
    bsd = await addOrg(db, 'bsd', ['isms']);
    for (const [column, role] of Object.entries(BUSINESS) as [Column, BusinessRole][]) {
      const user = await addUser(db, `u.${column.toLowerCase()}`, [{ org: ndt }], { kind: column === 'EA' ? 'guest' : 'person' });
      await grantRole(db, ndt, user, 'isms', role);
      users[column] = user;
    }
    users.TA = await addUser(db, 'u.ta', [{ org: ndt, adminRoles: ['tenant_admin'] }]);
    users.SA = await addUser(db, 'u.sa', [{ org: ndt, adminRoles: ['storage_admin'] }]);
    users.OP = await addUser(db, 'u.op', [{ org: ndt }], { platformOperator: true });
    multi = await addUser(db, 'multi', [{ org: ndt }, { org: bsd }]);
    await grantRole(db, ndt, multi, 'isms', 'ms_manager');
    await grantRole(db, ndt, multi, 'qms', 'domain_owner');
    await grantRole(db, bsd, multi, 'isms', 'internal_auditor');
    // Organisations are listed in `position` order (G.5 orgs[]).
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.organization').set({ position: 2 }).where('id', '=', bsd.tenant.id).execute());
    ctx = await createAuthzApp(db);
    evaluator = ctx.moduleRef.get(RolePermissionEvaluator);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const decide = (principal: Principal, permission: Permission, ms = 'isms') => {
    const scope = PLATFORM_SCOPED.has(permission) ? 'platform' : ORG_SCOPED.has(permission) ? 'org' : 'ms';
    return evaluator.evaluate(principal, permission, scope === 'ms' ? { scope, ms } : { scope });
  };

  it('uses the role-based evaluator for PERMISSION_EVALUATOR', () => {
    expect(ctx.moduleRef.get(PERMISSION_EVALUATOR)).toBe(evaluator);
  });

  it('decides every F.6 row for a user holding each role', async () => {
    expect(Object.keys(F6).sort()).toEqual([...PERMISSIONS].sort());
    const mismatches: string[] = [];
    for (const column of Object.keys(users) as Column[]) {
      const principal = principalOf(users[column]!, ndt);
      for (const permission of PERMISSIONS) {
        const expected = F6[permission][column] ?? null;
        const actual = await decide(principal, permission);
        if (actual !== expected) mismatches.push(`${column} ${permission}: expected ${expected}, got ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('lets an organisation role in an ms-scoped row grant it in every system (link_health.run for the Storage Admin)', async () => {
    const sa = principalOf(users.SA!, ndt);
    expect(await decide(sa, 'link_health.run', 'isms')).toBe('full');
    expect(await decide(sa, 'link_health.run', 'qms')).toBe('full');
    expect(await decide(sa, 'ms.read', 'qms')).toBeNull();
    const ta = principalOf(users.TA!, ndt);
    expect(await decide(ta, 'link_health.run', 'qms')).toBeNull();
    // Administrative roles carry no business permission (TS 7.1).
    expect(await decide(ta, 'ms.read', 'isms')).toBeNull();
  });

  it('counts business roles only in the system where they are held, and "any system" rows for org permissions', async () => {
    const mm = principalOf(users.MM!, ndt);
    expect(await decide(mm, 'applicability.manage', 'isms')).toBe('full');
    expect(await decide(mm, 'applicability.manage', 'qms')).toBeNull();
    const m = principalOf(multi, ndt);
    expect(await decide(m, 'applicability.manage', 'qms')).toBeNull();
    expect(await decide(m, 'applicability.complete', 'qms')).toBe('own');
    expect(await decide(m, 'storage.repository.read')).toBe('full');
    expect(await evaluator.evaluate(m, 'audit_trail.read', { scope: 'any_ms' })).toBe('full');
    // The same user in bsd holds only internal_auditor.
    const inBsd = principalOf(multi, bsd);
    expect(await decide(inBsd, 'applicability.manage', 'isms')).toBeNull();
    expect(await decide(inBsd, 'finding.raise', 'isms')).toBe('full');
    expect(await decide(inBsd, 'storage.repository.read')).toBeNull();
    expect(await decide(inBsd, 'pack.read')).toBe('full');
  });

  it('answers 404 for a system of another organisation or an unknown slug', async () => {
    const mm = principalOf(users.MM!, bsd);
    await expect(decide(mm, 'ms.read', 'qms')).rejects.toBeInstanceOf(NotFoundError);
    await expect(decide(principalOf(users.MM!, ndt), 'ms.read', 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('counts only active grants: pending, rejected, deleted and expired grants grant nothing', async () => {
    const cases: [string, Parameters<typeof grantRole>[5]][] = [
      ['g.pending', { approvalStatus: 'pending_approval' }],
      ['g.rejected', { approvalStatus: 'rejected' }],
      ['g.deleted', { deleted: true }],
      // Expiry is judged on the server clock (mocked at T0 in these tests).
      ['g.expired', { validUntil: new Date(ctx.clock.now().getTime() - 60_000) }],
    ];
    for (const [handle, options] of cases) {
      const user = await addUser(db, handle, [{ org: ndt }]);
      await grantRole(db, ndt, user, 'isms', 'ms_manager', options);
      const principal = principalOf(user, ndt);
      expect(await decide(principal, 'ms.read'), handle).toBeNull();
      expect(await evaluator.rolesByMs(principal), handle).toEqual({});
    }
    const future = await addUser(db, 'g.future', [{ org: ndt }]);
    await grantRole(db, ndt, future, 'isms', 'ms_manager', { validUntil: new Date(ctx.clock.now().getTime() + 60_000) });
    expect(await decide(principalOf(future, ndt), 'ms.read')).toBe('full');
  });

  it('grants nothing through a disabled or invited membership', async () => {
    for (const status of ['disabled', 'invited'] as const) {
      const user = await addUser(db, `m.${status}`, [{ org: ndt, adminRoles: ['tenant_admin'], status }]);
      await grantRole(db, ndt, user, 'isms', 'ms_manager');
      const principal = principalOf(user, ndt);
      expect(await decide(principal, 'ms.read'), status).toBeNull();
      expect(await decide(principal, 'user.manage'), status).toBeNull();
    }
  });

  it('keeps external auditors to the audited system: never in any_ms or org checks, and says when only the auditor role grants', async () => {
    const ea = principalOf(users.EA!, ndt);
    expect(await evaluator.evaluateDetailed(ea, 'ms.read', { scope: 'ms', ms: 'isms' })).toMatchObject({ decision: 'full', externalAuditorOnly: true, system: { id: ndt.systems.isms } });
    expect(await evaluator.evaluate(ea, 'audit_trail.read', { scope: 'any_ms' })).toBeNull();
    expect(await evaluator.evaluate(ea, 'ms.read', { scope: 'any_ms' })).toBeNull();
    expect(await decide(ea, 'ms.read', 'qms')).toBeNull();
    // A guest account counts only its external auditor role.
    await grantRole(db, ndt, users.EA!, 'qms', 'ms_manager');
    expect(await decide(principalOf(users.EA!, ndt), 'ms.read', 'qms')).toBeNull();
    // A person holding the auditor role and another role: the other role decides.
    const both = await addUser(db, 'ea.do', [{ org: ndt }]);
    await grantRole(db, ndt, both, 'isms', 'external_auditor');
    await grantRole(db, ndt, both, 'isms', 'domain_owner');
    expect(await evaluator.evaluateDetailed(principalOf(both, ndt), 'ms.read', { scope: 'ms', ms: 'isms' })).toMatchObject({ decision: 'own', externalAuditorOnly: false });
    expect(await evaluator.evaluateDetailed(principalOf(both, ndt), 'audit_trail.read', { scope: 'ms', ms: 'isms' })).toMatchObject({ decision: 'full', externalAuditorOnly: true });
  });

  it('reads platform roles for a principal without an organisation', async () => {
    const op = principalOf(users.OP!, null);
    expect(await evaluator.evaluate(op, 'ops.read', { scope: 'platform' })).toBe('full');
    expect(await evaluator.evaluate(op, 'user.manage', { scope: 'org' })).toBeNull();
    await expect(evaluator.evaluate(op, 'ms.read', { scope: 'ms', ms: 'isms' })).rejects.toBeInstanceOf(NotFoundError);
    expect(await evaluator.permissionSet(op)).toEqual({ org: ['ops.read', 'ops.jobs.run', 'ops.users.manage'], ms: {} });
  });

  it('returns Me with roles, UI roles and permissions per system of a fixture organisation (D.2, F.7)', async () => {
    const client = await sessionFor(ctx, multi, { org: ndt });
    const response = await client.get('/api/v1/me');
    expect(response.statusCode).toBe(200);
    const me = response.json() as Me;
    expect(Me.safeParse(me).success).toBe(true);
    expect(me.org).toEqual({ id: ndt.tenant.id, slug: 'ndt', name: 'Test organisation ndt' });
    expect(me.rolesByMs).toEqual({ isms: ['ms_manager'], qms: ['domain_owner'] });
    expect(me.uiRoleByMs).toEqual({ isms: 'manager', qms: 'owner' });
    expect(me.adminRoles).toEqual([]);
    expect(me.platformRoles).toEqual([]);
    expect(me.permissions.org).toEqual(['storage.repository.read', 'pack.read']);
    expect(me.permissions.ms.isms).toContain('applicability.verify');
    expect(me.permissions.ms.isms).toContain('audit_trail.read');
    expect(me.permissions.ms.qms).toEqual(
      expect.arrayContaining(['ms.read', 'applicability.complete', 'document.review', 'storage.object.read', 'risk.residual.accept']),
    );
    expect(me.permissions.ms.qms).not.toContain('applicability.verify');
    expect(me.orgs.map((o) => [o.id, o.ms])).toEqual([
      ['ndt', ['isms', 'qms']],
      ['bsd', ['isms']],
    ]);
    expect(me.orgs[0]).toMatchObject({ deploy: 'onprem', sites: 1 });
    expect(me.csrfToken).toBe(client.csrfToken);
    expect(me.session.authMethod).toBe('local');

    const sa = await sessionFor(ctx, users.SA!, { org: ndt });
    const saMe = (await sa.get('/api/v1/me')).json() as Me;
    expect(saMe.adminRoles).toEqual(['storage_admin']);
    expect(saMe.rolesByMs).toEqual({});
    expect(saMe.permissions.ms).toEqual({ isms: ['link_health.run'], qms: ['link_health.run'] });
    expect(saMe.orgs).toEqual([{ id: 'ndt', name: 'Test organisation ndt', ms: [], deploy: 'onprem', sites: 1 }]);

    const op = await sessionFor(ctx, users.OP!, { org: null });
    const opMe = (await op.get('/api/v1/me')).json() as Me;
    expect(Me.safeParse(opMe).success).toBe(true);
    expect(opMe).toMatchObject({ org: null, platformRoles: ['platform_operator'], permissions: { org: ['ops.read', 'ops.jobs.run', 'ops.users.manage'], ms: {} } });
    expect(opMe.orgs.map((o) => o.id)).toEqual(['ndt']);
  });
});
