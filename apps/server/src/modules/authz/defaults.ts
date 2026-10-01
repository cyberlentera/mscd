// Default providers of the authz tokens (build plan B.4, WP-08). WP-39 replaces the permission evaluator, the scope
// policy and the Me assembler with role-aware implementations; the record resolver and the membership service
// already implement the D.1 and F.7 checks that need no roles.
import { Inject, Injectable } from '@nestjs/common';
import { RECORD_ENTITY_TYPES, SHAREABLE_ENTITY_TYPES, uiRoleFor, type Me, type PermissionSet, type UiRole } from '@mscd/shared';
import { sql } from 'kysely';
import { MscdConfig } from '../../config/mscd-config';
import { ForbiddenError, NotAMemberError, NotFoundError } from '../../common/problems';
import {
  PERMISSION_EVALUATOR,
  type AuthzState,
  type MeAssembler,
  type MembershipOptions,
  type MembershipService,
  type MsRef,
  type PermissionDecision,
  type PermissionEvaluator,
  type Principal,
  type ReadScope,
  type RecordResolver,
  type ResolvedRecord,
  type ScopePolicy,
  type ScopedRecord,
  type Trx,
} from '../../common/tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_SLUG = /^[a-z][a-z0-9-]{1,19}$/;
const HANDLE = /^[a-z][a-z0-9._-]{1,39}$/;
const RECORD_TYPES: ReadonlySet<string> = new Set(RECORD_ENTITY_TYPES);
const SHAREABLE_TYPES: ReadonlySet<string> = new Set(SHAREABLE_ENTITY_TYPES);

/** Deny-all evaluator: no permission is granted until WP-39 resolves roles (F.7). */
@Injectable()
export class DenyAllPermissionEvaluator implements PermissionEvaluator {
  async evaluate(): Promise<PermissionDecision> {
    return null;
  }

  async permissionSet(): Promise<PermissionSet> {
    return { org: [], ms: {} };
  }

  async rolesByMs(): Promise<Record<string, never>> {
    return {};
  }
}

/**
 * Pass-through scope policy: full reads for callers whose grant is not own-scoped; owner-scoped callers and
 * external auditors are refused, because their projections (D-04, D-34) come with WP-39.
 */
@Injectable()
export class PassThroughScopePolicy implements ScopePolicy {
  async readScope(_trx: Trx, principal: Principal, _ms: string, authz: AuthzState): Promise<ReadScope> {
    if (authz.ownOnly) throw new ForbiddenError('Owner-scoped access is not available');
    if (principal.user.kind === 'guest') throw new ForbiddenError('External auditor access is not available');
    return { kind: 'full' };
  }

  filter<T extends ScopedRecord>(scope: ReadScope, records: readonly T[]): T[] {
    if (scope.kind === 'full') return [...records];
    if (scope.kind === 'own') return records.filter((r) => r.ownerUserId === scope.userId || r.holderUserId === scope.userId);
    return [];
  }

  async canReadObject(_trx: Trx, principal: Principal, _ms: string, _storageObjectId: string, authz: AuthzState): Promise<boolean> {
    return !authz.ownOnly && principal.user.kind !== 'guest';
  }
}

/** D.1 and F.7 record resolution inside the tenant transaction (no roles involved). */
@Injectable()
export class TenantRecordResolver implements RecordResolver {
  async resolveMs(trx: Trx, ms: string): Promise<MsRef> {
    if (!MS_SLUG.test(ms)) throw new NotFoundError('Unknown management system');
    const row = await trx.selectFrom('management_system').select(['id', 'slug']).where('slug', '=', ms).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw new NotFoundError('Unknown management system');
    return { id: row.id, slug: row.slug };
  }

  async resolve(trx: Trx, ms: string, entityType: string, id: string, options: { forUpdate?: boolean } = {}): Promise<ResolvedRecord> {
    if (!RECORD_TYPES.has(entityType) || !UUID.test(id)) throw new NotFoundError();
    const system = await this.resolveMs(trx, ms);
    const table = sql.table(entityType);
    const lock = options.forUpdate ? sql` for update of t` : sql``;
    const query = SHAREABLE_TYPES.has(entityType)
      ? sql<Record<string, unknown>>`select t.* from ${table} t
          where t.id = ${id} and t.deleted_at is null
            and exists (select 1 from entity_ms_link l
                        where l.entity_type = ${entityType} and l.entity_id = t.id
                          and l.management_system_id = ${system.id} and l.deleted_at is null)${lock}`
      : sql<Record<string, unknown>>`select t.* from ${table} t
          where t.id = ${id} and t.deleted_at is null and t.management_system_id = ${system.id}${lock}`;
    const { rows } = await query.execute(trx);
    const row = rows[0];
    if (!row) throw new NotFoundError();
    return { entityType: entityType as ResolvedRecord['entityType'], id, ms: system, row };
  }
}

/** Active membership of the transaction's organisation (F.7 `MembershipService`, C.1 person columns). */
@Injectable()
export class TenantMembershipService implements MembershipService {
  async isMember(trx: Trx, userId: string, options: MembershipOptions = {}): Promise<boolean> {
    if (!UUID.test(userId)) return false;
    const { rows } = await sql<{ ok: number }>`
      select 1 as ok from platform.org_membership m
      join platform.app_user u on u.id = m.user_id
      where m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
        and m.user_id = ${userId} and m.status = 'active' and m.deleted_at is null
        and u.status = 'active' and u.deleted_at is null
        and (u.kind = 'person' or (${options.allowGuests === true} and u.kind = 'guest'))`.execute(trx);
    return rows.length > 0;
  }

  async assertMember(trx: Trx, userId: string, options: MembershipOptions = {}): Promise<void> {
    if (!(await this.isMember(trx, userId, options))) throw new NotAMemberError();
  }

  async resolveHandle(trx: Trx, handle: string, options: MembershipOptions = {}): Promise<string | null> {
    if (handle === 'none') return null;
    if (!HANDLE.test(handle)) throw new NotAMemberError(handle);
    const { rows } = await sql<{ id: string }>`
      select u.id from platform.org_membership m
      join platform.app_user u on u.id = m.user_id
      where m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
        and u.handle = ${handle} and m.status = 'active' and m.deleted_at is null
        and u.status = 'active' and u.deleted_at is null
        and (u.kind = 'person' or (${options.allowGuests === true} and u.kind = 'guest'))`.execute(trx);
    const row = rows[0];
    if (!row) throw new NotAMemberError(handle);
    return row.id;
  }
}

/** Minimal `Me` (D.2) from the principal and the permission evaluator; WP-39 adds memberships, roles and personas. */
@Injectable()
export class MinimalMeAssembler implements MeAssembler {
  constructor(
    private readonly config: MscdConfig,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
  ) {}

  async assemble(principal: Principal, options: { csrfToken: string }): Promise<Me> {
    const [permissions, rolesByMs] = await Promise.all([this.evaluator.permissionSet(principal), this.evaluator.rolesByMs(principal)]);
    const uiRoleByMs: Record<string, UiRole> = {};
    for (const [ms, roles] of Object.entries(rolesByMs)) {
      const ui = uiRoleFor(roles);
      if (ui) uiRoleByMs[ms] = ui;
    }
    const org = principal.org;
    const deploy = this.config.demoEnabled && org?.demoDeployLabel ? org.demoDeployLabel : this.config.deploy;
    const now = new Date();
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
      orgs: org ? [{ id: org.slug, name: org.name, ms: Object.keys(rolesByMs), deploy, sites: org.siteCount }] : [],
      rolesByMs,
      uiRoleByMs,
      adminRoles: [],
      platformRoles: [],
      permissions,
      csrfToken: options.csrfToken,
      session: {
        authMethod: session?.authMethod ?? 'guest',
        idleExpiresAt: (session?.idleExpiresAt ?? now).toISOString(),
        absoluteExpiresAt: (session?.absoluteExpiresAt ?? now).toISOString(),
      },
      preferences: {},
    };
  }
}
