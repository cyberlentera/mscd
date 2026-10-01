// Members of the organisation (build plan D.3 "Administration", F.6 Tenant Admin limits, TS 7.2):
// - `user.manage` changes only the organisation's membership row (status, admin roles);
// - global account fields (display name, job title, account status) and the MFA reset change only by the user, by
//   the platform operator, or by a Tenant Admin when the user has no other active membership;
// - `POST /admin/users` answers the same 202 for a new and an existing email, so other tenants' accounts are never
//   revealed; an existing account gets an `invited` membership that its owner accepts after signing in;
// - every path that enables a non-guest member checks the licence user limit (`LIC-USERS`, D-15).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OrgRole, Page, UserCreate, UserIdentityRegistration, UserListQuery, UserPatch, UserView } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/problems';
import { AUDIT_WRITER, LICENCE_GATE, type AuditWriter, type AuthzState, type LicenceGate, type Principal, type Trx } from '../../common/tokens';
import { NO_ORGANISATION } from '../authz/authz-infra';
import { MembershipDirectory } from '../authz/membership-directory';
import { RoleResolver } from '../authz/role-resolver';
import { AccountMailer } from '../identity/account-mailer';
import { handleBase, INVITATION_TTL_MS, InvitationService, type CreatedInvitation } from '../identity/invitation.service';
import { MfaService } from '../identity/mfa.service';
import { SessionService, type IssuedSession } from '../identity/session.service';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { memberPage, memberRow, toUserViews, type MemberRow } from './user-views';

const HANDLE = /^[a-z][a-z0-9._-]{1,39}$/;

function orgOf(principal: Principal): NonNullable<Principal['org']> {
  if (!principal.org) throw new NotFoundError('No current organisation');
  return principal.org;
}

function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger('AdminUsers');

  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly directory: MembershipDirectory,
    private readonly roles: RoleResolver,
    private readonly sessions: SessionService,
    private readonly invitations: InvitationService,
    private readonly mfa: MfaService,
    private readonly mailer: AccountMailer,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
  ) {}

  /** `GET /admin/users`: members of the organisation only. */
  async list(principal: Principal, query: UserListQuery): Promise<Page<UserView>> {
    const org = orgOf(principal);
    const { rows, total } = await this.scope.withTenant(tenantContextOf(principal), (trx) => memberPage(trx, org.id, query));
    const others = await this.directory.withOtherActiveMemberships(
      org.id,
      rows.map((r) => r.id),
    );
    const items = await this.scope.withTenant(tenantContextOf(principal), (trx) => toUserViews(trx, rows, others));
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  /**
   * `POST /admin/users`: invites a new account, or gives an existing account an `invited` membership (F.6). The
   * answer is the same 202 in every case that does not hit the licence limit, including an email of an account that
   * is already a member or is disabled, so nothing about other tenants' accounts is revealed.
   */
  async create(principal: Principal, body: UserCreate): Promise<{ status: 'invited' }> {
    const org = orgOf(principal);
    const adminRoles = [...new Set(body.adminRoles)] as OrgRole[];
    await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const sent = await this.invite(trx, org.id, body, adminRoles, principal.user.id);
      if (sent) {
        this.mailer.sendAfterCommit(trx, {
          to: { email: sent.email, userId: sent.userId },
          template: { name: 'invitation', link: sent.invitation.link, organisation: org.name, hours: INVITATION_TTL_MS / 3_600_000 },
        });
      }
    });
    return { status: 'invited' };
  }

  /**
   * The invitation of `POST /admin/users`, with the same audit shape in the organisation's view whatever the email
   * names (F.6: a Tenant Admin reads the organisation's `platform.audit_log` rows as metadata, so the rows must not
   * tell a new email from another tenant's account):
   * - an active member: nothing changes and nothing is written;
   * - otherwise the membership becomes (or is created as) `invited` and the organisation gets one `user.invited`
   *   entry with entity type `user` and the user id, for a new account, an account of another organisation (active,
   *   invited or disabled) and a former member alike;
   * - a new account's `user.created` is a platform entry without organisation (the account is global), so it is not
   *   listed in the organisation's view; the inviting organisation is in its `after` data for the operator;
   * - an invitation link is issued only for an account that was never activated (new, or invited and not accepted);
   *   an active account accepts after signing in, a disabled one once it is enabled again.
   * Returns the link to mail, or null.
   */
  private async invite(
    trx: Trx,
    orgId: string,
    body: UserCreate,
    adminRoles: OrgRole[],
    actorUserId: string,
  ): Promise<{ userId: string; email: string; invitation: CreatedInvitation } | null> {
    const actor = { userId: actorUserId, kind: 'user' as const };
    const email = body.email.trim();
    await this.licence.assertCanAddUser(trx, orgId);
    const existing = await trx
      .selectFrom('platform.app_user')
      .select(['id', 'handle', 'email', 'status'])
      .where(sql<string>`lower(email)`, '=', email.toLowerCase())
      .where('kind', '<>', 'guest')
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();

    let user: { id: string; handle: string; email: string; status: 'active' | 'invited' | 'disabled' };
    let newAccount = false;
    if (existing) {
      const membership = await trx
        .selectFrom('platform.org_membership')
        .select(['status', 'deleted_at'])
        .where('organization_id', '=', orgId)
        .where('user_id', '=', existing.id)
        .forUpdate()
        .executeTakeFirst();
      if (membership && membership.status === 'active' && membership.deleted_at === null) {
        this.logger.log(`POST /admin/users for organisation ${orgId} changed nothing: already an active member`);
        return null;
      }
      if (membership) {
        await trx
          .updateTable('platform.org_membership')
          .set({ status: 'invited', deleted_at: null, admin_roles: adminRoles, invited_by: actorUserId, accepted_at: null })
          .where('organization_id', '=', orgId)
          .where('user_id', '=', existing.id)
          .execute();
      } else {
        // The default organisation only when the account has no other active membership (read outside the tenant's
        // RLS view, which shows only this organisation's rows).
        const others = await this.directory.withOtherActiveMemberships(orgId, [existing.id]);
        await trx
          .insertInto('platform.org_membership')
          .values({ organization_id: orgId, user_id: existing.id, status: 'invited', admin_roles: adminRoles, invited_by: actorUserId, is_default: !others.has(existing.id) })
          .execute();
      }
      user = existing;
    } else {
      const handle = await this.uniqueHandle(trx, email);
      const created = await trx
        .insertInto('platform.app_user')
        .values({
          handle,
          email,
          display_name: body.displayName.trim() || (email.split('@')[0] ?? handle),
          job_title: body.jobTitle?.trim() || null,
          kind: 'person',
          status: 'invited',
          mfa_required: true,
          created_by: actorUserId,
          updated_by: actorUserId,
        })
        .returning(['id', 'handle', 'email'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('platform.org_membership')
        .values({ organization_id: orgId, user_id: created.id, status: 'invited', admin_roles: adminRoles, invited_by: actorUserId, is_default: true })
        .execute();
      user = { ...created, status: 'invited' };
      newAccount = true;
      await this.audit.record(trx, {
        action: 'user.created',
        actor,
        organizationId: null,
        entityType: 'user',
        entityId: user.id,
        entityCode: user.handle,
        after: { handle: user.handle, email: user.email, status: 'invited', invitedTo: orgId },
      });
    }

    const invitation = user.status === 'invited' ? await this.invitations.createInvitation(trx, { orgId, userId: user.id, email: user.email, createdBy: actorUserId }) : null;
    await this.audit.record(trx, {
      action: 'user.invited',
      actor,
      organizationId: orgId,
      entityType: 'user',
      entityId: user.id,
      entityCode: user.handle,
      after: {
        userId: user.id,
        adminRoles,
        newAccount,
        link: invitation !== null,
        ...(invitation ? { invitationId: invitation.invitationId, expiresAt: invitation.expiresAt.toISOString() } : {}),
        at: this.clock.now().toISOString(),
      },
    });
    return invitation ? { userId: user.id, email: user.email, invitation } : null;
  }

  /** A free handle from the email's local part (`rina.kusuma`, then `rina.kusuma-2`, ...), as `InvitationService` does. */
  private async uniqueHandle(trx: Trx, email: string): Promise<string> {
    const base = handleBase(email);
    for (let n = 1; n < 1000; n += 1) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (!HANDLE.test(candidate)) continue;
      const taken = await trx.selectFrom('platform.app_user').select('id').where('handle', '=', candidate).executeTakeFirst();
      if (!taken) return candidate;
    }
    throw new ConflictError('No free user handle for this email address');
  }

  /**
   * Refuses changes of global fields and the MFA reset for an invited membership: until the user accepts, the Tenant
   * Admin sees only what the organisation supplied, and the answer must not depend on the account's other memberships.
   */
  private async assertNotInvited(principal: Principal, orgId: string, userId: string, path: string): Promise<void> {
    const row = await this.scope.withTenant(tenantContextOf(principal), (trx) => memberRow(trx, orgId, userId));
    if (!row) throw new NotFoundError('Not a member of this organisation');
    if (row.membership_status === 'invited') {
      throw new ValidationError([{ path, message: 'The account of an invited member changes only after the user accepts the invitation' }]);
    }
  }

  /** `PATCH /admin/users/{id}`: membership fields always; global fields only within the F.6 limits. */
  async update(request: FastifyRequest, reply: FastifyReply, principal: Principal, userId: string, patch: UserPatch): Promise<UserView> {
    const org = orgOf(principal);
    const actorId = principal.user.id;
    const self = actorId === userId;
    const globalChange = patch.displayName !== undefined || patch.jobTitle !== undefined || patch.accountStatus !== undefined;
    if (globalChange && !self) await this.assertNotInvited(principal, org.id, userId, 'body');
    // F.6: global fields change by the user, the platform operator or a Tenant Admin of the user's only organisation.
    if (globalChange && !self && (await this.directory.hasOtherActiveMembership(org.id, userId))) {
      throw new ForbiddenError("The user is a member of another organisation: only the user or the platform operator changes the account's global fields");
    }
    const rotated = await this.scope.withTenant(tenantContextOf(principal), async (trx): Promise<IssuedSession | null> => {
      const member = await this.lockMember(trx, org.id, userId);
      let ownRolesChanged = false;

      // Membership fields (`user.manage`, F.6).
      const membershipChanges: { status?: 'active' | 'disabled'; admin_roles?: OrgRole[] } = {};
      if (patch.membershipStatus !== undefined && patch.membershipStatus !== member.membership_status) {
        if (member.membership_status === 'invited') {
          throw new ValidationError([{ path: 'body.membershipStatus', message: 'An invited membership becomes active when the user accepts it' }]);
        }
        if (self && patch.membershipStatus === 'disabled') throw new ForbiddenError('You cannot disable your own membership');
        membershipChanges.status = patch.membershipStatus;
      }
      if (patch.adminRoles !== undefined) {
        const next = [...new Set(patch.adminRoles)] as OrgRole[];
        if (!sameRoles(next, member.admin_roles)) membershipChanges.admin_roles = next;
      }
      if (membershipChanges.admin_roles && member.admin_roles.includes('tenant_admin') && !membershipChanges.admin_roles.includes('tenant_admin')) {
        await this.assertAnotherTenantAdmin(trx, org.id, userId);
      }
      if (membershipChanges.status === 'disabled' && member.admin_roles.includes('tenant_admin')) {
        await this.assertAnotherTenantAdmin(trx, org.id, userId);
      }
      if (membershipChanges.status === 'active' && member.kind === 'person' && member.account_status === 'active') {
        await this.licence.assertCanAddUser(trx, org.id);
      }
      if (Object.keys(membershipChanges).length > 0) {
        await trx
          .updateTable('platform.org_membership')
          .set(membershipChanges)
          .where('organization_id', '=', org.id)
          .where('user_id', '=', userId)
          .execute();
        await this.audit.record(trx, {
          action: 'membership.updated',
          organizationId: org.id,
          entityType: 'org_membership',
          entityId: userId,
          entityCode: await this.handleOf(trx, member),
          before: { status: member.membership_status, adminRoles: member.admin_roles },
          after: { status: membershipChanges.status ?? member.membership_status, adminRoles: membershipChanges.admin_roles ?? member.admin_roles },
        });
        // F.1: a disabled membership ends the user's sessions in this organisation.
        if (membershipChanges.status === 'disabled') await this.sessions.revokeOrganisationSessions(trx, org.id, 'membership_removed', { userId });
        if (self && membershipChanges.admin_roles) ownRolesChanged = true;
      }

      // Global account fields (F.6 limits checked above).
      const accountChanges: { display_name?: string; job_title?: string | null; status?: 'active' | 'disabled'; updated_by?: string } = {};
      if (patch.displayName !== undefined && patch.displayName !== member.display_name) accountChanges.display_name = patch.displayName;
      if (patch.jobTitle !== undefined && (patch.jobTitle || null) !== member.job_title) accountChanges.job_title = patch.jobTitle || null;
      if (patch.accountStatus !== undefined && patch.accountStatus !== member.account_status) {
        if (member.account_status === 'invited') {
          throw new ValidationError([{ path: 'body.accountStatus', message: 'An invited account becomes active when the user accepts the invitation' }]);
        }
        if (self && patch.accountStatus === 'disabled') throw new ForbiddenError('You cannot disable your own account');
        if (patch.accountStatus === 'disabled' && member.admin_roles.includes('tenant_admin') && member.membership_status === 'active') {
          await this.assertAnotherTenantAdmin(trx, org.id, userId);
        }
        if (patch.accountStatus === 'active' && member.kind === 'person' && (membershipChanges.status ?? member.membership_status) === 'active') {
          await this.licence.assertCanAddUser(trx, org.id);
        }
        accountChanges.status = patch.accountStatus;
      }
      if (Object.keys(accountChanges).length > 0) {
        accountChanges.updated_by = actorId;
        await trx.updateTable('platform.app_user').set(accountChanges).where('id', '=', userId).execute();
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        if (accountChanges.display_name !== undefined) [before.displayName, after.displayName] = [member.display_name, accountChanges.display_name];
        if (accountChanges.job_title !== undefined) [before.jobTitle, after.jobTitle] = [member.job_title, accountChanges.job_title];
        if (accountChanges.status !== undefined) [before.accountStatus, after.accountStatus] = [member.account_status, accountChanges.status];
        await this.audit.record(trx, {
          action: 'user.updated',
          organizationId: org.id,
          entityType: 'user',
          entityId: userId,
          entityCode: await this.handleOf(trx, member),
          before,
          after,
        });
        // F.1: a disabled user loses every session.
        if (accountChanges.status === 'disabled') await this.sessions.revokeUserSessions(trx, userId, 'user_disabled');
      }
      // F.1: a change of the caller's own roles gives the caller a new session id.
      if (ownRolesChanged) {
        const current = this.sessions.currentOf(request);
        if (current) return this.sessions.rotate(trx, current.row);
      }
      return null;
    });
    if (rotated) {
      this.sessions.setCookie(reply, rotated);
      this.roles.forget(principal);
    }
    return this.view(principal, userId);
  }

  /**
   * `POST /admin/users/{id}/reset-mfa` (F.5, F.6): the platform operator for any account; a Tenant Admin only for a
   * member without another active membership. Revokes the user's sessions and emails the user (`MfaService`).
   */
  async resetMfa(principal: Principal, authz: AuthzState, userId: string): Promise<void> {
    const operator = authz.granted.has('ops.users.manage');
    const org = principal.org;
    const actor = { userId: principal.user.id, kind: operator ? ('operator' as const) : ('user' as const) };
    if (operator) {
      const run = async (trx: Trx) => {
        const user = await trx.selectFrom('platform.app_user').select(['id', 'kind']).where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
        if (!user || user.kind === 'system') throw new NotFoundError('Unknown user');
        await this.mfa.resetFactor(trx, userId, { organizationId: org?.id ?? null, actor });
      };
      if (org) await this.scope.withTenant(tenantContextOf(principal), run);
      else await this.scope.withTenant({ ...NO_ORGANISATION, userId: principal.user.id }, run);
      return;
    }
    const tenant = orgOf(principal);
    await this.assertNotInvited(principal, tenant.id, userId, 'id');
    if (await this.directory.hasOtherActiveMembership(tenant.id, userId)) {
      throw new ForbiddenError('The user is a member of another organisation: only the platform operator resets the second factor');
    }
    await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      await this.lockMember(trx, tenant.id, userId);
      await this.mfa.resetFactor(trx, userId, { organizationId: tenant.id, actor });
    });
  }

  /** `POST /admin/users/{id}/identities` (D-25): pre-registration of a provider subject for a member. */
  async registerIdentity(principal: Principal, userId: string, body: UserIdentityRegistration): Promise<void> {
    const org = orgOf(principal);
    await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const member = await memberRow(trx, org.id, userId);
      if (!member || member.kind === 'guest') throw new NotFoundError('Not a member of this organisation');
      const provider = await trx
        .selectFrom('platform.identity_provider')
        .select(['id', 'slug'])
        .where('organization_id', '=', org.id)
        .where('slug', '=', body.provider)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!provider) throw new NotFoundError('Unknown identity provider of this organisation');
      const linked = await trx
        .selectFrom('platform.user_identity')
        .select('user_id')
        .where('identity_provider_id', '=', provider.id)
        .where('subject', '=', body.subject)
        .executeTakeFirst();
      if (linked) throw new ConflictError('This subject is already linked to an account');
      await trx
        .insertInto('platform.user_identity')
        .values({ identity_provider_id: provider.id, subject: body.subject, user_id: userId, link_method: 'admin', linked_by: principal.user.id, linked_at: this.clock.now() })
        .execute();
      await this.audit.record(trx, {
        action: 'identity.registered',
        organizationId: org.id,
        entityType: 'user',
        entityId: userId,
        entityCode: await this.handleOf(trx, member),
        after: { provider: provider.slug, subject: body.subject, linkMethod: 'admin' },
      });
    });
  }

  /** The `UserView` of one member. */
  async view(principal: Principal, userId: string): Promise<UserView> {
    const org = orgOf(principal);
    const others = await this.directory.withOtherActiveMemberships(org.id, [userId]);
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await memberRow(trx, org.id, userId);
      if (!row) throw new NotFoundError('Not a member of this organisation');
      const [view] = await toUserViews(trx, [row], others);
      return view!;
    });
  }

  /** The account's own handle for audit entries (an invited member's row carries none, see `membersQuery`). */
  private async handleOf(trx: Trx, member: MemberRow): Promise<string> {
    if (member.handle !== null) return member.handle;
    const row = await trx.selectFrom('platform.app_user').select('handle').where('id', '=', member.id).executeTakeFirstOrThrow();
    return row.handle;
  }

  /** The member row, locked for the change (404 when the user is not a member). */
  private async lockMember(trx: Trx, orgId: string, userId: string): Promise<MemberRow> {
    const locked = await trx
      .selectFrom('platform.org_membership')
      .select('user_id')
      .where('organization_id', '=', orgId)
      .where('user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    const member = locked ? await memberRow(trx, orgId, userId) : undefined;
    if (!member) throw new NotFoundError('Not a member of this organisation');
    return member;
  }

  /** The organisation keeps at least one active Tenant Admin besides `userId` (400 otherwise). */
  private async assertAnotherTenantAdmin(trx: Trx, orgId: string, userId: string): Promise<void> {
    const other = await trx
      .selectFrom('platform.org_membership as m')
      .innerJoin('platform.app_user as u', 'u.id', 'm.user_id')
      .select('m.user_id')
      .where('m.organization_id', '=', orgId)
      .where('m.user_id', '<>', userId)
      .where('m.status', '=', 'active')
      .where('m.deleted_at', 'is', null)
      .where('u.status', '=', 'active')
      .where('u.deleted_at', 'is', null)
      .where(sql<boolean>`'tenant_admin' = any(m.admin_roles)`)
      .executeTakeFirst();
    if (!other) throw new ValidationError([{ path: 'body', message: 'The organisation needs at least one active Tenant Admin' }]);
  }
}
