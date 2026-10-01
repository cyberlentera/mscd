// MEMBERSHIP_SERVICE (build plan F.7): person fields of commands name active members of the organisation only. The
// check runs in the tenant transaction (`app.org_id`); guests count only where the column allows external auditors.
// The `assert_member` trigger (C.4) is the backstop in the database.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { NotAMemberError } from '../../common/problems';
import type { MembershipOptions, MembershipService, Trx } from '../../common/tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE = /^[a-z][a-z0-9._-]{1,39}$/;

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
