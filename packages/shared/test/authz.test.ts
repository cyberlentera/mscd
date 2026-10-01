// The permission matrix against build plan F.6, the decision helpers of F.7 and the UI role mapping.
import { describe, expect, it } from 'vitest';
import {
  BUSINESS_ROLES, PERMISSIONS, PERMISSION_MATRIX, effectiveGrant, evaluatePermission, permissionsFor, rolesHolding, uiRoleFor,
} from '../src/index.js';
import type { BusinessRole, OrgRole, Permission, PermissionGrant, PlatformRole, RoleContext, TenancyMode } from '../src/index.js';
import { planPermissionRows } from './helpers.js';

const COLUMNS = [
  'ms_manager', 'programme_owner', 'domain_owner', 'risk_owner', 'internal_auditor', 'top_management', 'external_auditor',
  'compliance_investigator', 'tenant_admin', 'storage_admin', 'platform_operator',
] as const;
const ORG_COLUMNS: readonly string[] = ['tenant_admin', 'storage_admin'];

/** The grant a plan row describes. */
function expectedGrant(scopeCell: string, cells: string[]): Omit<PermissionGrant, 'conditions'> {
  const tenancy: TenancyMode | undefined = scopeCell.includes('(single)') ? 'single' : undefined;
  const grant = {
    scope: (tenancy ? 'org' : scopeCell) as PermissionGrant['scope'],
    roles: [] as BusinessRole[],
    own: [] as BusinessRole[],
    orgRoles: [] as OrgRole[],
    anyMsRoles: [] as BusinessRole[],
    platformRoles: [] as PlatformRole[],
    ...(tenancy ? { tenancy } : {}),
  };
  const anyMs: Record<string, BusinessRole> = { MM: 'ms_manager', IA: 'internal_auditor', TM: 'top_management' };
  COLUMNS.forEach((role, i) => {
    const cell = cells[i] ?? '';
    if (!cell) return;
    const anyMatch = cell.match(/^(MM|IA|TM) of any system$/);
    if (anyMatch) grant.anyMsRoles.push(anyMs[anyMatch[1] as string] as BusinessRole);
    else if (role === 'platform_operator') grant.platformRoles.push(role);
    else if (ORG_COLUMNS.includes(role)) grant.orgRoles.push(role as OrgRole);
    else if (cell.startsWith('own')) grant.own.push(role as BusinessRole);
    else grant.roles.push(role as BusinessRole);
  });
  return grant;
}

const sorted = <T>(a: readonly T[]) => [...a].sort();

describe('PERMISSION_MATRIX', () => {
  const rows = planPermissionRows();
  const planned = rows.flatMap((r) => r.permissions);

  it('has exactly the permissions of F.6, in plan order', () => {
    expect(planned.length).toBeGreaterThan(55);
    expect([...PERMISSIONS]).toEqual(planned);
    expect(Object.keys(PERMISSION_MATRIX).sort()).toEqual([...planned].sort());
  });

  for (const row of rows) {
    for (const permission of row.permissions) {
      it(`matches the F.6 row of ${permission}`, () => {
        const actual = PERMISSION_MATRIX[permission as Permission];
        const expected = expectedGrant(row.scope, row.cells);
        expect(actual.scope).toBe(expected.scope);
        expect(sorted(actual.roles)).toEqual(sorted(expected.roles));
        expect(sorted(actual.own)).toEqual(sorted(expected.own));
        expect(sorted(actual.orgRoles)).toEqual(sorted(expected.orgRoles));
        expect(sorted(actual.anyMsRoles)).toEqual(sorted(expected.anyMsRoles));
        expect(sorted(actual.platformRoles)).toEqual(sorted(expected.platformRoles));
        expect(actual.tenancy).toBe(expected.tenancy);
        // Cells with a condition besides yes or own carry it in `conditions`.
        COLUMNS.forEach((role, i) => {
          const cell = row.cells[i] ?? '';
          const plain = ['', 'yes', 'own', 'yes (single)', 'yes (multi)'].includes(cell) || / of any system$/.test(cell);
          if (!plain) expect(actual.conditions?.[role], `${permission} ${role}: ${cell}`).toBeTruthy();
        });
      });
    }
  }

  it('gives administrative roles no business permission (TS 7.1)', () => {
    for (const p of PERMISSIONS) {
      const g = PERMISSION_MATRIX[p];
      if (g.scope === 'ms' && p !== 'link_health.run') expect(g.orgRoles, p).toEqual([]);
    }
  });
});

const ctx = (over: Partial<RoleContext> = {}): RoleContext => ({
  tenancy: 'single', msRoles: [], anyMsRoles: [], orgRoles: [], platformRoles: [], ...over,
});

describe('evaluatePermission', () => {
  it('grants full, own or nothing from the business roles in the system', () => {
    expect(evaluatePermission('applicability.verify', ctx({ msRoles: ['programme_owner'] }))).toBe('full');
    expect(evaluatePermission('applicability.complete', ctx({ msRoles: ['domain_owner'] }))).toBe('own');
    expect(evaluatePermission('applicability.complete', ctx({ msRoles: ['domain_owner', 'ms_manager'] }))).toBe('full');
    expect(evaluatePermission('applicability.manage', ctx({ msRoles: ['internal_auditor'] }))).toBeNull();
    expect(evaluatePermission('risk.residual.accept', ctx({ msRoles: ['ms_manager'] }))).toBe('own');
  });

  it('applies organisation roles to ms-scoped rows in every system (F.7)', () => {
    expect(evaluatePermission('link_health.run', ctx({ orgRoles: ['storage_admin'] }))).toBe('full');
    expect(evaluatePermission('ms.read', ctx({ orgRoles: ['tenant_admin'] }))).toBeNull();
  });

  it('applies "of any system" rows to org-scoped permissions', () => {
    expect(evaluatePermission('storage.repository.read', ctx({ anyMsRoles: ['ms_manager'] }))).toBe('full');
    expect(evaluatePermission('pack.read', ctx({ anyMsRoles: ['internal_auditor'] }))).toBe('full');
    expect(evaluatePermission('license.read', ctx({ anyMsRoles: ['top_management'] }))).toBe('full');
    expect(evaluatePermission('license.read', ctx({ anyMsRoles: ['ms_manager'] }))).toBeNull();
    expect(evaluatePermission('storage.repository.manage', ctx({ anyMsRoles: ['ms_manager'] }))).toBeNull();
  });

  it('switches pack.install and license.manage with the tenancy mode (D-17, D-32)', () => {
    for (const p of ['pack.install', 'license.manage'] as const) {
      expect(evaluatePermission(p, ctx({ tenancy: 'single', orgRoles: ['tenant_admin'] }))).toBe('full');
      expect(evaluatePermission(p, ctx({ tenancy: 'single', platformRoles: ['platform_operator'] }))).toBeNull();
      expect(evaluatePermission(p, ctx({ tenancy: 'multi', orgRoles: ['tenant_admin'] }))).toBeNull();
      expect(evaluatePermission(p, ctx({ tenancy: 'multi', platformRoles: ['platform_operator'] }))).toBe('full');
      expect(effectiveGrant(p, 'multi').scope).toBe('platform');
      expect(effectiveGrant(p, 'single').scope).toBe('org');
    }
  });

  it('keeps platform permissions to the platform operator', () => {
    expect(evaluatePermission('ops.read', ctx({ platformRoles: ['platform_operator'] }))).toBe('full');
    expect(evaluatePermission('ops.read', ctx({ orgRoles: ['tenant_admin'], msRoles: ['ms_manager'] }))).toBeNull();
  });
});

describe('permissionsFor and rolesHolding', () => {
  it('lists the permissions of one scope', () => {
    const owner = permissionsFor('ms', ctx({ msRoles: ['domain_owner'] }));
    expect(owner).toContain('ms.read');
    expect(owner).toContain('document.review');
    expect(owner).not.toContain('document.approve');
    expect(permissionsFor('org', ctx({ orgRoles: ['storage_admin'] }))).toEqual([
      'storage.repository.read', 'storage.repository.manage', 'storage.repository.test', 'storage.routing.manage', 'storage.object.metadata.read',
    ]);
    expect(permissionsFor('platform', ctx({ tenancy: 'multi', platformRoles: ['platform_operator'] }))).toEqual([
      'pack.install', 'license.manage', 'ops.read', 'ops.jobs.run', 'ops.users.manage',
    ]);
  });

  it('lists the roles holding a permission', () => {
    expect(rolesHolding('document.version.create', 'single')).toEqual({ full: ['ms_manager'], own: ['domain_owner'] });
    expect(rolesHolding('pack.install', 'multi')).toEqual({ full: ['platform_operator'], own: [] });
  });
});

describe('uiRoleFor', () => {
  it('maps business roles to the UI role of F.7', () => {
    expect(uiRoleFor(['ms_manager'])).toBe('manager');
    expect(uiRoleFor(['programme_owner'])).toBe('manager');
    expect(uiRoleFor(['internal_auditor'])).toBe('auditor');
    expect(uiRoleFor(['external_auditor'])).toBe('auditor');
    expect(uiRoleFor(['top_management'])).toBe('top');
    expect(uiRoleFor(['domain_owner'])).toBe('owner');
    expect(uiRoleFor(['risk_owner'])).toBe('owner');
    expect(uiRoleFor(['compliance_investigator'])).toBe('owner');
    expect(uiRoleFor([])).toBeNull();
  });

  it('takes the first match in the order manager, auditor, top, owner', () => {
    expect(uiRoleFor(['domain_owner', 'ms_manager'])).toBe('manager');
    expect(uiRoleFor(['domain_owner', 'internal_auditor'])).toBe('auditor');
    expect(uiRoleFor(['risk_owner', 'top_management'])).toBe('top');
    for (const role of BUSINESS_ROLES) expect(uiRoleFor([role]), role).not.toBeNull();
  });
});
