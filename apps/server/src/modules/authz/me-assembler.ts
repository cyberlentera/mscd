// ME_ASSEMBLER (build plan D.2 `Me`, G.5 `orgs[]`, F.7 UI role per system): the session user, the current
// organisation, the user's organisations with the systems where they hold a role, business roles and the UI role
// per system, organisation and platform roles, permissions per system, the CSRF token, session expiry, the demo
// personas (demo mode only) and the stored preferences.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DEMO_PERSONAS, UI_ROLE_LABELS, uiRoleFor, type Me, type Organisation, type UiRole } from '@mscd/shared';
import { PERMISSION_EVALUATOR, type MeAssembler, type PermissionEvaluator, type Principal, type TenantInfo } from '../../common/tokens';
import { PreferencesService } from '../identity/preferences.service';
import { tenantContextOf } from '../tenancy/tenant-scope';
import { AuthzInfra } from './authz-infra';
import { RoleResolver, type PrincipalRoles } from './role-resolver';

@Injectable()
export class MeAssemblerService implements MeAssembler {
  private readonly logger = new Logger('MeAssembler');
  private preferences?: PreferencesService | null;

  constructor(
    private readonly infra: AuthzInfra,
    private readonly roles: RoleResolver,
    private readonly moduleRef: ModuleRef,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
  ) {}

  /**
   * Business roles and permissions come from `PERMISSION_EVALUATOR` (the guard's source, also when a test replaces
   * it); organisations, organisation and platform roles from the role resolver.
   */
  async assemble(principal: Principal, options: { csrfToken: string }): Promise<Me> {
    const org = principal.org;
    const held: PrincipalRoles = this.roles.available
      ? await this.roles.rolesOf(principal)
      : { orgId: org?.id ?? null, systems: new Map(), orgRoles: [], platformRoles: [], membershipActive: false };
    const [rolesByMs, permissions] = [await this.evaluator.rolesByMs(principal), await this.evaluator.permissionSet(principal)];
    const uiRoleByMs: Record<string, UiRole> = {};
    for (const [ms, roles] of Object.entries(rolesByMs)) {
      const ui = uiRoleFor(roles);
      if (ui) uiRoleByMs[ms] = ui;
    }
    const orgs = this.roles.available ? await this.organisations(principal, held, Object.keys(rolesByMs)) : org ? [this.organisation(org, Object.keys(rolesByMs))] : [];
    const personas = this.roles.available ? await this.personas(principal) : undefined;
    const now = this.infra.now();
    const session = principal.session;
    return {
      user: {
        id: principal.user.id,
        handle: principal.user.handle,
        email: principal.user.email,
        displayName: principal.user.displayName,
        jobTitle: principal.user.jobTitle,
      },
      org: org ? { id: org.id, slug: org.slug, name: org.name } : null,
      orgs,
      rolesByMs,
      uiRoleByMs,
      adminRoles: [...held.orgRoles],
      platformRoles: [...held.platformRoles],
      permissions,
      csrfToken: options.csrfToken,
      session: {
        authMethod: session?.authMethod ?? 'guest',
        idleExpiresAt: (session?.idleExpiresAt ?? now).toISOString(),
        absoluteExpiresAt: (session?.absoluteExpiresAt ?? now).toISOString(),
      },
      ...(personas ? { personas } : {}),
      preferences: await this.preferencesOf(principal.user.id),
    };
  }

  /** G.5 `orgs[]`: the user's active memberships in organisation order, each with the systems where the user holds a role. */
  private async organisations(principal: Principal, held: PrincipalRoles, currentSystems: string[]): Promise<Organisation[]> {
    const userId = principal.user.id;
    const memberships = await this.infra.withUserOnly(userId, (trx) =>
      trx
        .selectFrom('platform.org_membership')
        .select('organization_id')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .execute(),
    );
    const tenants: TenantInfo[] = [];
    for (const m of memberships) {
      const tenant = m.organization_id === principal.org?.id ? principal.org : await this.infra.tenants.resolveById(m.organization_id);
      if (tenant && tenant.status !== 'archived') tenants.push(tenant);
    }
    tenants.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const out: Organisation[] = [];
    for (const tenant of tenants) {
      let systems: string[];
      if (tenant.id === held.orgId) {
        systems = currentSystems;
      } else {
        const other = await this.infra.scope.withTenant({ orgId: tenant.id, schema: tenant.schema, userId }, (trx) =>
          this.roles.loadIn(trx, tenant, userId, principal.user.kind, this.infra.now()),
        );
        systems = [...other.systems.values()].filter((s) => s.roles.length > 0).map((s) => s.slug);
      }
      out.push(this.organisation(tenant, systems));
    }
    return out;
  }

  private organisation(tenant: TenantInfo, systems: string[]): Organisation {
    const config = this.infra.config;
    const deploy = config.demoEnabled && tenant.demoDeployLabel ? tenant.demoDeployLabel : config.deploy;
    return { id: tenant.slug, name: tenant.name, ms: systems, deploy, sites: tenant.siteCount };
  }

  /**
   * Demo personas (D-20, G.3 `ROLES`): in demo mode with personas enabled, for a demo user, the persona users that
   * are active demo members of the current organisation, with the sample labels.
   */
  private async personas(principal: Principal): Promise<Me['personas']> {
    const demo = this.infra.config.profile.demo;
    if (!this.infra.config.demoEnabled || !demo.personas || !principal.org) return undefined;
    const handles = Object.values(DEMO_PERSONAS);
    const rows = await this.infra.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const self = await trx.selectFrom('platform.app_user').select('is_demo').where('id', '=', principal.user.id).executeTakeFirst();
      if (!self?.is_demo) return null;
      return trx
        .selectFrom('platform.app_user as u')
        .innerJoin('platform.org_membership as m', (join) =>
          join.onRef('m.user_id', '=', 'u.id').on('m.organization_id', '=', principal.org!.id).on('m.status', '=', 'active').on('m.deleted_at', 'is', null),
        )
        .select('u.handle')
        .where('u.handle', 'in', handles)
        .where('u.is_demo', '=', true)
        .where('u.status', '=', 'active')
        .where('u.deleted_at', 'is', null)
        .execute();
    });
    if (!rows) return undefined;
    const present = new Set(rows.map((r) => r.handle));
    const personas: NonNullable<Me['personas']> = {};
    for (const [role, handle] of Object.entries(DEMO_PERSONAS) as [UiRole, string][]) {
      if (present.has(handle)) personas[role] = { who: handle, label: [...UI_ROLE_LABELS[role]] as [string, string] };
    }
    return personas;
  }

  private async preferencesOf(userId: string): Promise<Record<string, unknown>> {
    if (this.preferences === undefined) {
      try {
        // Resolved at the first use, not injected: the identity module's PreferencesService (exported, global)
        // depends on this assembler through IdentityInfra.
        this.preferences = this.moduleRef.get(PreferencesService, { strict: false });
      } catch {
        this.preferences = null;
      }
    }
    if (!this.preferences || !this.roles.available) return {};
    try {
      return await this.preferences.get(userId);
    } catch (error) {
      this.logger.warn(`Could not read the preferences of user ${userId}: ${(error as Error).message}`);
      return {};
    }
  }
}
