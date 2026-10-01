// Memberships of other users across organisations (build plan F.6 Tenant Admin limits). A Tenant Admin may change a
// user's global account fields or reset the user's second factor only when the user has no other active
// membership; the answer needs the user's memberships in every organisation, which the organisation-scoped RLS of
// `platform.org_membership` (D-31) hides from a tenant transaction. Platform scope is not available to this module
// (F.10), so each user's rows are read through the policy's user clause (`user_id = app.user_id`) in a read-only
// transaction bound to no organisation: the transaction sees exactly that user's membership rows and nothing else,
// and only whether one of them is active in another organisation leaves this service.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuthzInfra } from './authz-infra';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class MembershipDirectory {
  constructor(private readonly infra: AuthzInfra) {}

  /** The users among `userIds` who hold an active membership of an organisation other than `orgId`. */
  async withOtherActiveMemberships(orgId: string, userIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(userIds)].filter((id) => UUID.test(id));
    const found = new Set<string>();
    if (ids.length === 0) return found;
    await this.infra.withUserOnly(ids[0]!, async (trx) => {
      for (const id of ids) {
        // Transaction-local: the policy's user clause now shows this user's membership rows only.
        await sql`select set_config('app.user_id', ${id}, true)`.execute(trx);
        const row = await trx
          .selectFrom('platform.org_membership as m')
          .innerJoin('platform.organization as o', 'o.id', 'm.organization_id')
          .select('m.organization_id')
          .where('m.user_id', '=', id)
          .where('m.organization_id', '<>', orgId)
          .where('m.status', '=', 'active')
          .where('m.deleted_at', 'is', null)
          .where('o.deleted_at', 'is', null)
          .where('o.status', '<>', 'archived')
          .limit(1)
          .executeTakeFirst();
        if (row) found.add(id);
      }
    });
    return found;
  }

  /** True when the user holds an active membership of an organisation other than `orgId`. */
  async hasOtherActiveMembership(orgId: string, userId: string): Promise<boolean> {
    return (await this.withOtherActiveMemberships(orgId, [userId])).has(userId);
  }
}
