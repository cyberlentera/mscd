// PERMISSION_EVALUATOR (build plan F.6, F.7): decisions from the shared F.6 matrix over the roles of the principal.
// - `ms` checks use the business roles held in that system, plus organisation roles listed in ms-scoped rows (they
//   grant the permission in every system, for example `link_health.run` for the Storage Admin) and platform roles.
//   An unknown system is 404.
// - `any_ms` checks use the business roles held in any system, never the external auditor role (F.7).
// - `org` and `platform` checks use organisation and platform roles, and the "MM of any system" rows.
// The external auditor role counts only when no other role grants the permission in the system; the decision then
// says so (`externalAuditorOnly`), and the guard admits such requests only on GET routes (F.7).
import { Injectable } from '@nestjs/common';
import {
  evaluatePermission,
  evaluatePermissionInAnySystem,
  permissionsFor,
  withoutExternalAuditor,
  type BusinessRole,
  type Permission,
  type PermissionSet,
  type RoleContext,
} from '@mscd/shared';
import { NotFoundError } from '../../common/problems';
import type { PermissionDecision, PermissionEvaluator, PermissionTarget, Principal } from '../../common/tokens';
import { AuthzInfra } from './authz-infra';
import { RoleResolver, rolesInAnySystem, type PrincipalRoles, type SystemRoles } from './role-resolver';

/** A decision with what the guard needs besides it. */
export interface DetailedDecision {
  decision: PermissionDecision;
  /** True when only the external auditor role grants the permission (F.7: GET routes of the audited system only). */
  externalAuditorOnly: boolean;
  /** The system of an `ms` check (known also when the permission is denied). */
  system: Pick<SystemRoles, 'id' | 'slug'> | null;
}

/** A permission evaluator that can explain its decisions (the guard uses it when the evaluator offers it). */
export interface DetailedPermissionEvaluator extends PermissionEvaluator {
  evaluateDetailed(principal: Principal, permission: Permission, target: PermissionTarget): Promise<DetailedDecision>;
}

export function isDetailedEvaluator(evaluator: PermissionEvaluator): evaluator is DetailedPermissionEvaluator {
  return typeof (evaluator as Partial<DetailedPermissionEvaluator>).evaluateDetailed === 'function';
}

const DENIED: DetailedDecision = { decision: null, externalAuditorOnly: false, system: null };

@Injectable()
export class RolePermissionEvaluator implements DetailedPermissionEvaluator {
  constructor(
    private readonly infra: AuthzInfra,
    private readonly roles: RoleResolver,
  ) {}

  async evaluate(principal: Principal, permission: Permission, target: PermissionTarget): Promise<PermissionDecision> {
    return (await this.evaluateDetailed(principal, permission, target)).decision;
  }

  async evaluateDetailed(principal: Principal, permission: Permission, target: PermissionTarget): Promise<DetailedDecision> {
    // Without the database services no role is known: deny (fail closed).
    if (!this.roles.available) return DENIED;
    const held = await this.roles.rolesOf(principal);
    const base = this.context(held);
    switch (target.scope) {
      case 'ms': {
        const system = target.ms ? held.systems.get(target.ms) : undefined;
        if (!system) throw new NotFoundError('Unknown management system');
        const withAuditor = evaluatePermission(permission, { ...base, msRoles: system.roles });
        const without = evaluatePermission(permission, { ...base, msRoles: withoutExternalAuditor(system.roles) });
        return {
          decision: without ?? withAuditor,
          externalAuditorOnly: without === null && withAuditor !== null,
          system: { id: system.id, slug: system.slug },
        };
      }
      case 'any_ms':
        return { decision: evaluatePermissionInAnySystem(permission, base), externalAuditorOnly: false, system: null };
      default:
        return { decision: evaluatePermission(permission, base), externalAuditorOnly: false, system: null };
    }
  }

  async permissionSet(principal: Principal): Promise<PermissionSet> {
    if (!this.roles.available) return { org: [], ms: {} };
    const held = await this.roles.rolesOf(principal);
    return permissionSetOf(held, this.infra.config.profile.tenancy.mode);
  }

  async rolesByMs(principal: Principal): Promise<Record<string, BusinessRole[]>> {
    if (!this.roles.available) return {};
    return rolesByMsOf(await this.roles.rolesOf(principal));
  }

  /** The role context of org and platform checks (`msRoles` empty; ms checks set it). */
  private context(held: PrincipalRoles): RoleContext {
    return {
      tenancy: this.infra.config.profile.tenancy.mode,
      msRoles: [],
      anyMsRoles: withoutExternalAuditor(rolesInAnySystem(held)),
      orgRoles: held.orgRoles,
      platformRoles: held.platformRoles,
    };
  }
}

/** `Me.permissions` (D.2): organisation and platform permissions, and per system every permission held there. */
export function permissionSetOf(held: PrincipalRoles, tenancy: RoleContext['tenancy']): PermissionSet {
  const base: RoleContext = {
    tenancy,
    msRoles: [],
    anyMsRoles: withoutExternalAuditor(rolesInAnySystem(held)),
    orgRoles: held.orgRoles,
    platformRoles: held.platformRoles,
  };
  const org = [...permissionsFor('org', base), ...permissionsFor('platform', base)];
  const ms: Record<string, Permission[]> = {};
  for (const system of held.systems.values()) {
    const list = permissionsFor('ms', { ...base, msRoles: system.roles });
    if (list.length > 0) ms[system.slug] = list;
  }
  return { org, ms };
}

/** `Me.rolesByMs`: the systems where the user holds a business role, in system order. */
export function rolesByMsOf(held: PrincipalRoles): Record<string, BusinessRole[]> {
  const out: Record<string, BusinessRole[]> = {};
  for (const system of held.systems.values()) if (system.roles.length > 0) out[system.slug] = [...system.roles];
  return out;
}
