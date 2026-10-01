// Guest accounts of auditor grants (build plan F.14 steps 1 and 5, D-27). Used by the auditor access module inside
// its tenant transaction:
// - `createGuestAccount`: a new account of kind `guest` for one grant (handle `guest-<8 hex>`, the grant address,
//   `mfa_required`, no password) with an `active` membership of the organisation. An existing account with the same
//   address (a person's, or the guest of another grant) is never reused: the email index of `platform.app_user`
//   leaves guests out, so each grant has its own account.
// - `endGrantAccess`: what a revoked or expired grant ends at once: every session signed in through the grant, every
//   open one-time code transaction of the grant, and the guest's membership (disabled). The caller sets
//   `valid_until` on the role row and writes the audit entry.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../../common/clock';
import { AUDIT_WRITER, type AuditWriter, type Trx } from '../../../common/tokens';
import { inPlatformScope } from '../platform-scope';
import { SessionService } from '../session.service';
import { newGuestHandle } from './guest-tokens';

export interface CreatedGuest {
  userId: string;
  handle: string;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown })?.code === '23505';
}

@Injectable()
export class GuestAccountService {
  constructor(
    private readonly sessions: SessionService,
    private readonly clock: Clock,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** A new guest account and its active membership of `orgId`, written in the caller's tenant transaction. */
  async createGuestAccount(trx: Trx, input: { orgId: string; email: string; actorUserId: string }): Promise<CreatedGuest> {
    const email = input.email.trim();
    let created: { id: string; handle: string } | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const handle = newGuestHandle();
      // A savepoint keeps the transaction usable when the random handle is already taken.
      const savepoint = `guest_handle_${attempt}`;
      await sql.raw(`savepoint ${savepoint}`).execute(trx);
      try {
        created = await trx
          .insertInto('platform.app_user')
          .values({
            handle,
            email,
            display_name: email,
            kind: 'guest',
            status: 'active',
            mfa_required: true,
            created_by: input.actorUserId,
            updated_by: input.actorUserId,
          })
          .returning(['id', 'handle'])
          .executeTakeFirstOrThrow();
        await sql.raw(`release savepoint ${savepoint}`).execute(trx);
      } catch (error) {
        await sql.raw(`rollback to savepoint ${savepoint}`).execute(trx);
        if (!isUniqueViolation(error)) throw error;
      }
    }
    if (!created) throw new Error('Could not choose a free guest handle');
    await trx
      .insertInto('platform.org_membership')
      .values({
        organization_id: input.orgId,
        user_id: created.id,
        status: 'active',
        is_default: true,
        invited_by: input.actorUserId,
        accepted_at: this.clock.now(),
      })
      .execute();
    await this.audit.record(trx, {
      action: 'user.created',
      actor: { userId: input.actorUserId, kind: 'user' },
      organizationId: input.orgId,
      entityType: 'user',
      entityId: created.id,
      entityCode: created.handle,
      after: { handle: created.handle, kind: 'guest', status: 'active', purpose: 'auditor_access' },
    });
    return { userId: created.id, handle: created.handle };
  }

  /**
   * Ends what a grant gave (F.14 step 5): its sessions, its open one-time code transactions and the guest's
   * membership. Returns the number of sessions revoked.
   */
  async endGrantAccess(trx: Trx, grant: { id: string; userId: string | null; orgId: string }): Promise<number> {
    const revoked = await this.sessions.revokeGrantSessions(trx, grant.id, 'grant_revoked');
    await inPlatformScope(trx, async () => {
      await trx.deleteFrom('platform.auth_transaction').where('kind', '=', 'guest_otp').where('target_id', '=', grant.id).execute();
      if (grant.userId) {
        await trx
          .updateTable('platform.org_membership')
          .set({ status: 'disabled' })
          .where('organization_id', '=', grant.orgId)
          .where('user_id', '=', grant.userId)
          .where('status', '<>', 'disabled')
          .execute();
      }
    });
    return revoked;
  }
}
