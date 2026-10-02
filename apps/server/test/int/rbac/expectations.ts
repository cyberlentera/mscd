// Expected guard decisions of the generated RBAC tests (build plan J.5, F.6, F.7), derived from the F.6 matrix as
// data (`PERMISSION_MATRIX`) and the route table, for a user who holds exactly one role. The rules are written out
// here instead of calling the server's evaluator, so the suite checks the wiring of every route (permission, scope,
// system source, alternatives, machine rows) and the guard pipeline against the plan.
import {
  EXTERNAL_AUDITOR, effectiveGrant, machinePermissions, permissionCase, type Permission, type PermissionCheckScope, type RouteDef,
} from '@mscd/shared';
import { BUSINESS_ROLE, ORG_ROLE, type RoleKey } from '../contract/harness';

export interface Check {
  permission: Permission;
  scope: PermissionCheckScope;
}

/** Whether a user holding only `role` (business roles in the request's system) passes one check (F.6, F.7). */
export function roleHolds(role: RoleKey, check: Check): boolean {
  const grant = effectiveGrant(check.permission, 'single');
  if (role === 'OP') return grant.platformRoles.includes('platform_operator');
  if (check.scope === 'platform' || grant.scope === 'platform') return false;
  const orgRole = ORG_ROLE[role];
  if (orgRole && grant.orgRoles.includes(orgRole)) return true;
  const business = BUSINESS_ROLE[role];
  if (!business) return false;
  switch (check.scope) {
    case 'org':
      // "MM of any system" rows; the external auditor role never counts outside the audited system.
      return business !== EXTERNAL_AUDITOR && grant.anyMsRoles.includes(business);
    case 'any_ms':
      return business !== EXTERNAL_AUDITOR && (grant.roles.includes(business) || grant.own.includes(business));
    case 'ms':
      return grant.roles.includes(business) || grant.own.includes(business);
    default:
      return false;
  }
}

/** The checks the guard makes for a request (`member` is the value of a `permissionBy` member). */
export function checksOf(def: RouteDef, member?: unknown): { any: Check[]; all: Check[] } {
  const scopeOf = (permission: Permission, scope?: PermissionCheckScope): PermissionCheckScope => scope ?? effectiveGrant(permission, 'single').scope;
  if (def.permissionBy) {
    const c = permissionCase(def.permissionBy, member);
    return { any: [{ permission: c.permission, scope: c.scope }], all: [] };
  }
  const any: Check[] = [];
  const add = (permission: Permission, scope?: PermissionCheckScope) => {
    const s = scopeOf(permission, scope);
    if (!any.some((c) => c.permission === permission && c.scope === s)) any.push({ permission, scope: s });
  };
  if (def.permission) add(def.permission, def.scope as PermissionCheckScope | undefined);
  for (const alt of def.anyOf ?? []) add(alt.permission, alt.scope);
  if (def.machine) for (const p of machinePermissions(def.machine)) add(p, 'ms');
  const all = (def.allOf ?? []).map((p) => ({ permission: p, scope: scopeOf(p, def.scope as PermissionCheckScope | undefined) }));
  return { any, all };
}

/** True for routes the guard treats as business routes (everything but sign-in steps and the user's own session). */
export function isBusinessRoute(def: RouteDef): boolean {
  return def.auth !== 'public' && !def.path.startsWith('/api/v1/auth/') && !def.id.startsWith('me.');
}

/** True when the guard admits a user who holds only `role` (F.6, F.7). */
export function expectedAllowed(def: RouteDef, role: RoleKey, member?: unknown): boolean {
  // External auditors (accounts whose only role is the auditor role) never change anything on business routes.
  if (role === 'EA' && def.method !== 'GET' && isBusinessRoute(def)) return false;
  const { any, all } = checksOf(def, member);
  if (any.length === 0 && all.length === 0) return true;
  if (!any.some((c) => roleHolds(role, c))) return false;
  return all.every((c) => roleHolds(role, c));
}
