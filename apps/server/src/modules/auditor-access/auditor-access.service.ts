// Guest auditor grants of a management system (build plan F.14 steps 1 and 5, D-27, D-34, D.3; feature
// `auditor_guest_access`, D-15).
//
// A grant creates its own guest account (`GuestAccountService`), an `active` membership, a `user_ms_role`
// `external_auditor` with `valid_until` = the grant expiry, and a single-use access link whose token only the
// auditor's mailbox receives (`<public_url>/guest#<token>`); the requester gets the grant id and expiry, never the
// link. Guests are not counted towards `max_users` (D-15), so no `LIC-USERS` check runs.
//
// Revocation (and expiry) ends the guest's sessions, open one-time code transactions and membership at once and
// sets `valid_until = now()` on the role row; audited `auditor_access.revoked`. Expired grants are closed the same
// way whenever grants of the organisation are read or created here (the role resolver already ignores roles past
// `valid_until`, so an expired grant gives no access in between).
import { Inject, Injectable } from '@nestjs/common';
import type { AuditorAccessGrantView, AuditorAccessRequest, AuditorAccessResult, CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { fmtDay, localDate } from '../../common/dates';
import { ConflictError, NotFoundError } from '../../common/problems';
import { AUDIT_WRITER, LICENCE_GATE, SYSTEM_USER_ID, type AuditWriter, type LicenceGate, type Principal, type Trx } from '../../common/tokens';
import { AccountMailer } from '../identity/account-mailer';
import { GuestAccountService } from '../identity/guest/guest-accounts.service';
import { newGuestLinkToken } from '../identity/guest/guest-tokens';
import { sha256 } from '../identity/tokens';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';

const DAY_MS = 86_400_000;

interface SystemRow {
  id: string;
  slug: string;
  code: string;
  name: string;
}

interface GrantListRow {
  id: string;
  email: string;
  user_id: string | null;
  user_ms_role_id: string | null;
  created_at: Date;
  expires_at: Date;
  link_used_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  guest_handle: string | null;
  created_by_handle: string | null;
  revoked_by_handle: string | null;
}

@Injectable()
export class AuditorAccessService {
  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
    private readonly guests: GuestAccountService,
    private readonly mailer: AccountMailer,
  ) {}

  /** `POST /ms/{ms}/auditor-access` (201). */
  async grant(principal: Principal, ms: string, body: AuditorAccessRequest): Promise<AuditorAccessResult> {
    const org = principal.org!;
    const email = body.email.trim();
    const days = body.expiresInDays ?? 14;
    const result = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms);
      await this.licence.assertFeature(org.id, 'auditor_guest_access', trx);
      const now = this.clock.now();
      await this.closeExpired(trx, org.id, now);
      const expiresAt = new Date(now.getTime() + days * DAY_MS);
      const actor = principal.user.id;
      const guest = await this.guests.createGuestAccount(trx, { orgId: org.id, email, actorUserId: actor });
      const role = await trx
        .insertInto('user_ms_role')
        .values({
          user_id: guest.userId,
          management_system_id: system.id,
          role: 'external_auditor',
          valid_until: expiresAt,
          approval_status: 'active',
          created_by: actor,
          updated_by: actor,
          requested_by: actor,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const token = newGuestLinkToken(org.id);
      const grant = await trx
        .insertInto('auditor_access_grant')
        .values({
          management_system_id: system.id,
          email,
          user_id: guest.userId,
          user_ms_role_id: role.id,
          token_hash: sha256(token),
          expires_at: expiresAt,
          created_by: actor,
          updated_by: actor,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        action: 'auditor_access.granted',
        msId: system.id,
        entityType: 'auditor_access_grant',
        entityId: grant.id,
        entityCode: guest.handle,
        after: { email, guestHandle: guest.handle, expiresAt: expiresAt.toISOString(), expiresInDays: days, roleId: role.id },
      });
      // The link goes to the auditor's mailbox only (F.14 step 1); it is never returned or logged.
      this.mailer.sendAfterCommit(trx, {
        to: { email, userId: guest.userId },
        template: {
          name: 'guest_access_link',
          link: this.mailer.appLink(`/guest#${token}`),
          organisation: org.name,
          system: `${system.code} ${system.name}`,
          expiresOn: fmtDay(localDate(expiresAt, org.timeZone)),
        },
      });
      return { grantId: grant.id, expiresAt };
    });
    return {
      ok: true,
      changed: [ms],
      message: [`Auditor access granted until ${fmtDay(localDate(result.expiresAt, org.timeZone))}; the link was emailed to ${email}`, `Akses auditor diberikan sampai ${fmtDay(localDate(result.expiresAt, org.timeZone), 'id')}; tautan dikirim ke ${email}`],
      data: { grantId: result.grantId, expiresAt: result.expiresAt.toISOString() },
    };
  }

  /** `GET /ms/{ms}/auditor-access`: the grants of the system, newest first, without tokens. */
  async list(principal: Principal, ms: string): Promise<AuditorAccessGrantView[]> {
    const org = principal.org!;
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms);
      const now = this.clock.now();
      await this.closeExpired(trx, org.id, now);
      const { rows } = await sql<GrantListRow>`
        select g.id, g.email, g.user_id, g.user_ms_role_id, g.created_at, g.expires_at, g.link_used_at, g.last_used_at,
               g.revoked_at, gu.handle as guest_handle, cu.handle as created_by_handle, ru.handle as revoked_by_handle
        from auditor_access_grant g
        left join platform.app_user gu on gu.id = g.user_id
        left join platform.app_user cu on cu.id = g.created_by
        left join platform.app_user ru on ru.id = g.revoked_by
        where g.management_system_id = ${system.id} and g.deleted_at is null
        order by g.created_at desc, g.id`.execute(trx);
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        guestHandle: r.guest_handle,
        createdBy: r.created_by_handle,
        createdAt: r.created_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        linkUsedAt: r.link_used_at?.toISOString() ?? null,
        lastUsedAt: r.last_used_at?.toISOString() ?? null,
        revokedAt: r.revoked_at?.toISOString() ?? null,
        revokedBy: r.revoked_by_handle,
        active: r.revoked_at === null && r.expires_at.getTime() > now.getTime(),
      }));
    });
  }

  /** `POST /ms/{ms}/auditor-access/{id}/revoke`: ends the guest's sessions and role at once (F.14 step 5). */
  async revoke(principal: Principal, ms: string, id: string): Promise<CommandResult> {
    const org = principal.org!;
    const ended = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms);
      const grant = await trx
        .selectFrom('auditor_access_grant')
        .select(['id', 'email', 'user_id', 'user_ms_role_id', 'revoked_at'])
        .where('id', '=', id)
        .where('management_system_id', '=', system.id)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!grant) throw new NotFoundError('No such auditor access grant');
      if (grant.revoked_at) throw new ConflictError('The auditor access grant is already revoked');
      const now = this.clock.now();
      return this.end(trx, org.id, system.id, grant, now, { reason: 'revoked', actor: principal.user.id });
    });
    return {
      ok: true,
      changed: [ms],
      count: ended.sessions,
      message: ['Auditor access revoked; the auditor was signed out', 'Akses auditor dicabut; auditor telah dikeluarkan'],
    };
  }

  // -------------------------------------------------------------------------------------------------------------

  private async system(trx: Trx, ms: string): Promise<SystemRow> {
    const row = await trx.selectFrom('management_system').select(['id', 'slug', 'code', 'name']).where('slug', '=', ms).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw new NotFoundError('Unknown management system');
    return row;
  }

  /**
   * Ends a grant: `revoked_at` (revocation only), the role's `valid_until`, the guest's sessions, open code
   * transactions and membership; audits `auditor_access.revoked`.
   */
  private async end(
    trx: Trx,
    orgId: string,
    msId: string,
    grant: { id: string; email: string; user_id: string | null; user_ms_role_id: string | null },
    now: Date,
    how: { reason: 'revoked' | 'expired'; actor: string },
  ): Promise<{ sessions: number }> {
    if (how.reason === 'revoked') {
      await trx.updateTable('auditor_access_grant').set({ revoked_at: now, revoked_by: how.actor, updated_by: how.actor, updated_at: now }).where('id', '=', grant.id).execute();
    }
    if (grant.user_ms_role_id) {
      await trx
        .updateTable('user_ms_role')
        .set({ valid_until: now, updated_by: how.actor, updated_at: now })
        .where('id', '=', grant.user_ms_role_id)
        .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', now)]))
        .execute();
    }
    const sessions = await this.guests.endGrantAccess(trx, { id: grant.id, userId: grant.user_id, orgId });
    await this.audit.record(trx, {
      action: 'auditor_access.revoked',
      actor: how.actor === SYSTEM_USER_ID ? { userId: SYSTEM_USER_ID, kind: 'system' } : { userId: how.actor, kind: 'user' },
      msId,
      entityType: 'auditor_access_grant',
      entityId: grant.id,
      after: { reason: how.reason, email: grant.email, sessionsRevoked: sessions, at: now.toISOString() },
    });
    return { sessions };
  }

  /** Grants past `expires_at` whose guest membership is still active are ended as `expired` (F.14 step 5). */
  private async closeExpired(trx: Trx, orgId: string, now: Date): Promise<void> {
    const { rows } = await sql<{ id: string; email: string; user_id: string | null; user_ms_role_id: string | null; management_system_id: string }>`
      select g.id, g.email, g.user_id, g.user_ms_role_id, g.management_system_id
      from auditor_access_grant g
      join platform.org_membership m on m.user_id = g.user_id and m.organization_id = ${orgId}
      where g.deleted_at is null and g.revoked_at is null and g.expires_at <= ${now}
        and m.status = 'active' and m.deleted_at is null
      for update of g`.execute(trx);
    for (const grant of rows) await this.end(trx, orgId, grant.management_system_id, grant, now, { reason: 'expired', actor: SYSTEM_USER_ID });
  }
}
