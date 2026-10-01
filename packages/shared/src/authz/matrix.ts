// Permission matrix of build plan F.6 as data, read by the authorisation guard, `Me.permissions`, the auth fakes of
// the tests (J.2) and the generated RBAC tests (J.5). F.7 states how the guard applies it.
import { PERMISSIONS } from '../enums.js';
import type { BusinessRole, OrgRole, Permission, PermissionScope, PlatformRole, TenancyMode, UiRole } from '../enums.js';

/** One row of F.6. */
export interface PermissionGrant {
  /** Where the permission is checked: in one management system, in the organisation, or installation-wide. */
  scope: PermissionScope;
  /** Business roles that hold the permission in the system where they hold the role. */
  roles: readonly BusinessRole[];
  /** Business roles that hold it only for records whose owner or holder is the user ("own", D.3). */
  own: readonly BusinessRole[];
  /**
   * Organisation roles that hold it. For an ms-scoped permission an organisation role grants it in every system of
   * the organisation (F.6, F.7).
   */
  orgRoles: readonly OrgRole[];
  /** For org-scoped permissions: business roles that grant it when held in at least one system ("MM of any system"). */
  anyMsRoles: readonly BusinessRole[];
  /** Platform roles that hold it. */
  platformRoles: readonly PlatformRole[];
  /**
   * Tenancy-dependent row ("org (single), platform (multi)"): with `tenancy.mode` equal to this value the
   * organisation roles grant the permission at organisation scope; in the other mode only the platform roles grant
   * it, at platform scope (D-17, D-32). `effectiveGrant()` applies the rule.
   */
  tenancy?: TenancyMode;
  /** Matrix cells that carry a condition besides yes or own, keyed by role. */
  conditions?: Readonly<Partial<Record<BusinessRole | OrgRole | PlatformRole, string>>>;
}

const none = [] as const;

function ms(roles: readonly BusinessRole[], own: readonly BusinessRole[] = none, extra: Partial<PermissionGrant> = {}): PermissionGrant {
  return { scope: 'ms', roles, own, orgRoles: none, anyMsRoles: none, platformRoles: none, ...extra };
}
function org(orgRoles: readonly OrgRole[], anyMsRoles: readonly BusinessRole[] = none, extra: Partial<PermissionGrant> = {}): PermissionGrant {
  return { scope: 'org', roles: none, own: none, orgRoles, anyMsRoles, platformRoles: none, ...extra };
}
function platform(platformRoles: readonly PlatformRole[]): PermissionGrant {
  return { scope: 'platform', roles: none, own: none, orgRoles: none, anyMsRoles: none, platformRoles };
}

const MM = 'ms_manager';
const PO = 'programme_owner';
const DO = 'domain_owner';
const RO = 'risk_owner';
const IA = 'internal_auditor';
const TM = 'top_management';
const EA = 'external_auditor';
const CI = 'compliance_investigator';
const TA = 'tenant_admin';
const SA = 'storage_admin';
const OP = 'platform_operator';

/** F.6, one entry per permission code. */
export const PERMISSION_MATRIX: Readonly<Record<Permission, PermissionGrant>> = {
  'ms.read': ms([MM, PO, IA, TM, EA], [DO, RO, CI], {
    conditions: { [DO]: 'own rows', [RO]: 'own rows', [CI]: 'own rows', [EA]: 'projection (D-34), time-boxed, every request logged' },
  }),
  'applicability.complete': ms([MM], [DO, RO]),
  'applicability.verify': ms([MM, PO]),
  'applicability.manage': ms([MM]),
  'activity.transition': ms([MM], [DO, RO]),
  'activity.verify': ms([MM, PO]),
  'phase.verify': ms([MM]),
  'record.assign': ms([MM, PO]),
  'record.complete_action': ms([MM], [DO, RO, CI]),
  'record.delete': ms([MM]),
  'document.review': ms([MM], [DO]),
  'document.approve': ms([MM, PO]),
  'document.manage': ms([MM]),
  'document.version.create': ms([MM], [DO]),
  'evidence.file.submit': ms([MM], [DO, RO]),
  'evidence.manage': ms([MM], [DO, RO]),
  'register.manage': ms([MM], [DO, RO], { conditions: { [MM]: 'context issues, interested parties, assets and metrics' } }),
  'metric.record': ms([MM], [DO, RO]),
  'risk.manage': ms([MM], [RO], { conditions: { [RO]: 'assessment fields of own risks' } }),
  'risk.treatment.update': ms([MM], [DO, RO]),
  'risk.residual.accept': ms([], [MM, PO, DO, RO], { conditions: { [MM]: "the risk's owner_user_id", [PO]: "the risk's owner_user_id", [DO]: "the risk's owner_user_id", [RO]: "the risk's owner_user_id" } }),
  'entity_link.manage': ms([MM]),
  'ms.transition': ms([MM]),
  'reminder.send': ms([MM, PO, IA]),
  'audit.pending.all': ms([MM, PO]),
  'audit.pending.aggregate': ms([MM, PO, TM]),
  'audit_event.manage': ms([MM]),
  'prep_task.update': ms([MM], [DO, IA]),
  'cycle_item.update': ms([MM], [DO, IA]),
  'finding.raise': ms([MM, IA]),
  'finding.manage': ms([MM]),
  'corrective_action.manage': ms([MM]),
  'corrective_action.update': ms([MM], [DO, RO]),
  'corrective_action.verify': ms([MM, PO, IA]),
  'self_assessment.manage': ms([MM, IA]),
  'management_review.manage': ms([MM, PO]),
  'evidence_pack.build': ms([MM, IA]),
  'auditor_access.grant': ms([MM]),
  'export.run': ms([MM, PO, IA, TM]),
  'link_health.run': ms([MM], none, { orgRoles: [SA] }),
  'storage.move.request': ms([MM]),
  'storage.object.read': ms([MM, PO, IA, EA], [DO, RO, CI], { conditions: { [EA]: 'pack copies of the audited system only' } }),
  'audit_trail.read': ms([MM, EA], none, { conditions: { [EA]: 'time-boxed' } }),
  'storage.repository.read': org([TA, SA], [MM]),
  'storage.repository.manage': org([TA, SA]),
  'storage.repository.test': org([TA, SA]),
  'storage.routing.manage': org([TA, SA]),
  'storage.object.metadata.read': org([TA, SA]),
  'pack.read': org([TA], [MM, IA]),
  'pack.activate': org([TA]),
  'pack.install': org([TA], none, { platformRoles: [OP], tenancy: 'single' }),
  'license.read': org([TA], [TM]),
  'license.manage': org([TA], none, { platformRoles: [OP], tenancy: 'single' }),
  'user.manage': org([TA]),
  'idp.manage': org([TA]),
  'org.settings.manage': org([TA]),
  'ms.admin': org([TA]),
  'audit_trail.metadata.read': org([TA]),
  'ops.read': platform([OP]),
  'ops.jobs.run': platform([OP]),
  'ops.users.manage': platform([OP]),
};

/** The row of a permission with the tenancy rule applied (`tenancy` of `PermissionGrant`). */
export function effectiveGrant(permission: Permission, mode: TenancyMode): PermissionGrant {
  const grant = PERMISSION_MATRIX[permission];
  if (!grant.tenancy) return grant;
  if (mode === grant.tenancy) return { ...grant, platformRoles: none };
  return { ...grant, scope: 'platform', orgRoles: none, anyMsRoles: none };
}

/** Roles of the session user that the decision needs (F.7 role resolution). */
export interface RoleContext {
  tenancy: TenancyMode;
  /** Active business roles of the user in the system being checked; empty for org and platform scope checks. */
  msRoles: readonly BusinessRole[];
  /** Business roles the user holds in at least one system of the organisation ("MM of any system"). */
  anyMsRoles: readonly BusinessRole[];
  orgRoles: readonly OrgRole[];
  platformRoles: readonly PlatformRole[];
}

/** Grant decision for one permission: `full`, `own` (only own records, the service checks ownership) or null. */
export function evaluatePermission(permission: Permission, ctx: RoleContext): 'full' | 'own' | null {
  const g = effectiveGrant(permission, ctx.tenancy);
  const has = <T>(granted: readonly T[], held: readonly T[]) => granted.some((r) => held.includes(r));
  if (has(g.platformRoles, ctx.platformRoles)) return 'full';
  if (g.scope === 'platform') return null;
  if (has(g.orgRoles, ctx.orgRoles)) return 'full';
  if (g.scope === 'org') return has(g.anyMsRoles, ctx.anyMsRoles) ? 'full' : null;
  if (has(g.roles, ctx.msRoles)) return 'full';
  if (has(g.own, ctx.msRoles)) return 'own';
  return null;
}

/**
 * Grant decision for an ms-scoped permission held in at least one system of the organisation (a `permissionBy`
 * check with scope `any_ms`, D.3 "in at least one system"): the business roles the user holds in any system count.
 */
export function evaluatePermissionInAnySystem(permission: Permission, ctx: RoleContext): 'full' | 'own' | null {
  return evaluatePermission(permission, { ...ctx, msRoles: ctx.anyMsRoles });
}

/** Permissions of one scope that the context grants (full or own), in matrix order. */
export function permissionsFor(scope: PermissionScope, ctx: RoleContext): Permission[] {
  return PERMISSIONS.filter((p) => effectiveGrant(p, ctx.tenancy).scope === scope && evaluatePermission(p, ctx) !== null);
}

/** Every role that holds the permission in any form, for generated RBAC tests. */
export function rolesHolding(permission: Permission, mode: TenancyMode): {
  full: readonly (BusinessRole | OrgRole | PlatformRole)[];
  own: readonly BusinessRole[];
} {
  const g = effectiveGrant(permission, mode);
  return { full: [...g.roles, ...g.orgRoles, ...g.anyMsRoles, ...g.platformRoles], own: g.own };
}

/**
 * UI role for a user's business roles in one system (F.7): `manager` for MM or PO, `auditor` for IA or EA, `top`
 * for TM, `owner` for DO, RO or CI; the first match in that order wins. Null when the user holds no business role.
 */
export function uiRoleFor(roles: readonly BusinessRole[]): UiRole | null {
  if (roles.includes(MM) || roles.includes(PO)) return 'manager';
  if (roles.includes(IA) || roles.includes(EA)) return 'auditor';
  if (roles.includes(TM)) return 'top';
  if (roles.includes(DO) || roles.includes(RO) || roles.includes(CI)) return 'owner';
  return null;
}
