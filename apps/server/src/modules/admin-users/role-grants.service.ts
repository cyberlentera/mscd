// Role grants in a management system (build plan D.3, F.6 Tenant Admin limits, C.13 `user_ms_role.approval_status`):
// - a grant to the caller (self-grant) or to a member holding `tenant_admin` or `storage_admin` in the organisation
//   is created `pending_approval` and needs a different Tenant Admin who is neither the requester nor the grantee
//   (`SOD-SELF-GRANT`); with no such Tenant Admin it cannot be activated, and the answer says so (as A-50);
// - other grants are active at once;
// - every grant to an admin user is audited with `after_data.grantee_admin_roles`; pending grants notify the other
//   Tenant Admins (`role_grant_pending`).
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, Messages, Pair, RoleGrant, RoleGrantResult } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { BusinessRuleError, ConflictError, NotFoundError, TransitionNotAllowedError, ValidationError } from '../../common/problems';
import {
  AUDIT_WRITER,
  MEMBERSHIP_SERVICE,
  NOTIFICATION_WRITER,
  type AuditWriter,
  type MembershipService,
  type NotificationWriter,
  type Principal,
  type Trx,
} from '../../common/tokens';
import { RoleResolver } from '../authz/role-resolver';
import { SessionService, type IssuedSession } from '../identity/session.service';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GrantRow {
  id: string;
  user_id: string;
  role: string;
  approval_status: 'active' | 'pending_approval' | 'rejected';
  requested_by: string | null;
  is_primary: boolean;
  valid_until: Date | null;
}

/** Answer of a pending grant that no other Tenant Admin can approve yet (F.6, as A-50). */
export const NO_APPROVER_MESSAGE: Pair = [
  'No other Tenant Admin can approve this grant yet; it stays pending until one does',
  'Belum ada Tenant Admin lain yang dapat menyetujui pemberian peran ini; statusnya tetap menunggu hingga ada',
];

const SOD_MESSAGES: Messages = {
  en: 'A role grant is approved or rejected by a Tenant Admin who neither requested it nor receives it',
  id: 'Pemberian peran disetujui atau ditolak oleh Tenant Admin yang bukan pemohon dan bukan penerima',
};

function orgOf(principal: Principal): NonNullable<Principal['org']> {
  if (!principal.org) throw new NotFoundError('No current organisation');
  return principal.org;
}

@Injectable()
export class RoleGrantsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly roles: RoleResolver,
    private readonly sessions: SessionService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  /** `POST /admin/management-systems/{id}/roles`. */
  async grant(principal: Principal, msId: string, body: RoleGrant): Promise<RoleGrantResult> {
    const org = orgOf(principal);
    const actorId = principal.user.id;
    const now = this.clock.now();
    const validUntil = body.validUntil ? new Date(body.validUntil) : null;
    if (validUntil && validUntil.getTime() <= now.getTime()) {
      throw new ValidationError([{ path: 'body.validUntil', message: 'validUntil must be in the future' }]);
    }
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, msId);
      const granteeId = await this.members.resolveHandle(trx, body.user);
      if (!granteeId) throw new ValidationError([{ path: 'body.user', message: 'Name a member' }]);
      const granteeAdminRoles = await this.adminRolesOf(trx, org.id, granteeId);
      const needsApproval = granteeId === actorId || granteeAdminRoles.length > 0;

      const existing = await trx
        .selectFrom('user_ms_role')
        .select(['id', 'approval_status'])
        .where('user_id', '=', granteeId)
        .where('management_system_id', '=', system.id)
        .where('role', '=', body.role)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (existing && existing.approval_status !== 'rejected') {
        throw new ConflictError(existing.approval_status === 'active' ? 'The user already holds this role in the system' : 'This role grant is already waiting for approval');
      }
      if (existing) {
        // A rejected request is kept as a deleted row, so a new request can be made.
        await trx.updateTable('user_ms_role').set({ deleted_at: now, updated_by: actorId }).where('id', '=', existing.id).execute();
      }
      if (body.isPrimary) {
        const primary = await trx
          .selectFrom('user_ms_role')
          .select('id')
          .where('management_system_id', '=', system.id)
          .where('role', '=', body.role)
          .where('is_primary', '=', true)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (primary) throw new ConflictError('Another member holds the primary grant of this role in the system; revoke it first');
      }
      const approvalStatus = needsApproval ? ('pending_approval' as const) : ('active' as const);
      const row = await trx
        .insertInto('user_ms_role')
        .values({
          user_id: granteeId,
          management_system_id: system.id,
          role: body.role,
          is_primary: body.isPrimary ?? false,
          valid_until: validUntil,
          approval_status: approvalStatus,
          requested_by: actorId,
          created_by: actorId,
          updated_by: actorId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        action: needsApproval ? 'role.grant_requested' : 'role.granted',
        msId: system.id,
        entityType: 'user_ms_role',
        entityId: row.id,
        entityCode: body.user,
        after: {
          user: body.user,
          role: body.role,
          isPrimary: body.isPrimary ?? false,
          validUntil: validUntil?.toISOString() ?? null,
          approvalStatus,
          ...(granteeAdminRoles.length > 0 ? { grantee_admin_roles: granteeAdminRoles } : {}),
        },
      });
      let message: Pair | undefined;
      if (needsApproval) {
        const approvers = (await this.tenantAdmins(trx, org.id)).filter((id) => id !== actorId && id !== granteeId);
        for (const approver of approvers) {
          await this.notifications.create(trx, {
            recipientUserId: approver,
            kind: 'role_grant_pending',
            msId: system.id,
            title: ['Role grant waiting for approval', 'Pemberian peran menunggu persetujuan'],
            body: {
              en: `${principal.user.displayName} asks to grant ${body.role} in ${system.code} to ${body.user}. Approve or reject it under Administration.`,
              id: `${principal.user.displayName} meminta pemberian peran ${body.role} di ${system.code} kepada ${body.user}. Setujui atau tolak di Administrasi.`,
            },
          });
        }
        if (approvers.length === 0) message = NO_APPROVER_MESSAGE;
      }
      return {
        ok: true as const,
        changed: [system.slug],
        data: { approvalStatus, grantId: row.id },
        ...(message ? { message } : {}),
      };
    });
  }

  /** `POST .../roles/{roleId}/approve` and `/reject` (C.13): not by the requester, not by the grantee. */
  async decide(principal: Principal, msId: string, roleId: string, to: 'active' | 'rejected'): Promise<CommandResult> {
    const actorId = principal.user.id;
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, msId);
      const grant = await this.grantRow(trx, system.id, roleId);
      if (grant.approval_status !== 'pending_approval') throw new TransitionNotAllowedError(grant.approval_status, to);
      if (actorId === grant.requested_by || actorId === grant.user_id) throw new BusinessRuleError('SOD-SELF-GRANT', SOD_MESSAGES);
      await trx
        .updateTable('user_ms_role')
        .set({ approval_status: to, approved_by: actorId, updated_by: actorId })
        .where('id', '=', grant.id)
        .execute();
      const grantee = await trx.selectFrom('platform.app_user').select('handle').where('id', '=', grant.user_id).executeTakeFirstOrThrow();
      const granteeAdminRoles = await this.adminRolesOf(trx, principal.org!.id, grant.user_id);
      await this.audit.record(trx, {
        action: to === 'active' ? 'role.grant_approved' : 'role.grant_rejected',
        msId: system.id,
        entityType: 'user_ms_role',
        entityId: grant.id,
        entityCode: grantee.handle,
        before: { approvalStatus: grant.approval_status },
        after: {
          approvalStatus: to,
          user: grantee.handle,
          role: grant.role,
          ...(granteeAdminRoles.length > 0 ? { grantee_admin_roles: granteeAdminRoles } : {}),
        },
      });
      return { ok: true as const, changed: [system.slug], data: { approvalStatus: to } };
    });
  }

  /** `POST .../roles/{roleId}/revoke`: the grant ends at once (soft delete). */
  async revoke(request: FastifyRequest, reply: FastifyReply, principal: Principal, msId: string, roleId: string): Promise<void> {
    const actorId = principal.user.id;
    const now = this.clock.now();
    const rotated = await this.scope.withTenant(tenantContextOf(principal), async (trx): Promise<IssuedSession | null> => {
      const system = await this.system(trx, msId);
      const grant = await this.grantRow(trx, system.id, roleId);
      await trx.updateTable('user_ms_role').set({ deleted_at: now, updated_by: actorId }).where('id', '=', grant.id).execute();
      const grantee = await trx.selectFrom('platform.app_user').select(['handle', 'kind']).where('id', '=', grant.user_id).executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        action: 'role.revoked',
        msId: system.id,
        entityType: 'user_ms_role',
        entityId: grant.id,
        entityCode: grantee.handle,
        before: { approvalStatus: grant.approval_status },
        after: { user: grantee.handle, role: grant.role, revoked: true },
      });
      // A guest account exists only for its auditor grant: without the role its sessions end (F.14).
      if (grantee.kind === 'guest') await this.sessions.revokeUserSessions(trx, grant.user_id, 'grant_revoked');
      // F.1: a change of the caller's own roles gives the caller a new session id.
      if (grant.user_id === actorId && grant.approval_status === 'active') {
        const current = this.sessions.currentOf(request);
        if (current) return this.sessions.rotate(trx, current.row);
      }
      return null;
    });
    if (rotated) {
      this.sessions.setCookie(reply, rotated);
      this.roles.forget(principal);
    }
  }

  private async system(trx: Trx, msId: string): Promise<{ id: string; slug: string; code: string }> {
    if (!UUID.test(msId)) throw new NotFoundError('Unknown management system');
    const row = await trx.selectFrom('management_system').select(['id', 'slug', 'code']).where('id', '=', msId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw new NotFoundError('Unknown management system');
    return row;
  }

  private async grantRow(trx: Trx, msId: string, roleId: string): Promise<GrantRow> {
    const row = await trx
      .selectFrom('user_ms_role')
      .select(['id', 'user_id', 'role', 'approval_status', 'requested_by', 'is_primary', 'valid_until'])
      .where('id', '=', roleId)
      .where('management_system_id', '=', msId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Unknown role grant');
    return row;
  }

  private async adminRolesOf(trx: Trx, orgId: string, userId: string): Promise<string[]> {
    const row = await trx
      .selectFrom('platform.org_membership')
      .select('admin_roles')
      .where('organization_id', '=', orgId)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? [...row.admin_roles].sort() : [];
  }

  /** Active Tenant Admins of the organisation with an active account. */
  private async tenantAdmins(trx: Trx, orgId: string): Promise<string[]> {
    const rows = await trx
      .selectFrom('platform.org_membership as m')
      .innerJoin('platform.app_user as u', 'u.id', 'm.user_id')
      .select('m.user_id')
      .where('m.organization_id', '=', orgId)
      .where('m.status', '=', 'active')
      .where('m.deleted_at', 'is', null)
      .where('u.status', '=', 'active')
      .where('u.deleted_at', 'is', null)
      .where(sql<boolean>`'tenant_admin' = any(m.admin_roles)`)
      .orderBy('m.user_id')
      .execute();
    return rows.map((r) => r.user_id);
  }
}
