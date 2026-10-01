// Small queries the tenant jobs share: recipients by role and "already notified" checks.
import { sql } from 'kysely';
import type { NotificationKind } from '@mscd/shared';
import type { Trx } from '../../common/tokens';

/** Active MS Managers of a system (`user_ms_role`, approved, not expired). */
export async function msManagersOf(trx: Trx, msId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('user_ms_role')
    .select('user_id')
    .distinct()
    .where('management_system_id', '=', msId)
    .where('role', '=', 'ms_manager')
    .where('approval_status', '=', 'active')
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', sql<Date>`now()`)]))
    .orderBy('user_id')
    .execute();
  return rows.map((r) => r.user_id);
}

/** The primary MS Manager of a system, else its first MS Manager, else null. */
export async function primaryMsManagerOf(trx: Trx, msId: string): Promise<string | null> {
  const row = await trx
    .selectFrom('user_ms_role')
    .select('user_id')
    .where('management_system_id', '=', msId)
    .where('role', '=', 'ms_manager')
    .where('approval_status', '=', 'active')
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', sql<Date>`now()`)]))
    .orderBy('is_primary', 'desc')
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  return row?.user_id ?? null;
}

/** True when `recipient` already has a notification of `kind` about the record `entityId` (once per item). */
export async function notificationSent(trx: Trx, kind: NotificationKind, entityId: string, recipient: string): Promise<boolean> {
  const row = await trx
    .selectFrom('notification')
    .select('id')
    .where('kind', '=', kind)
    .where('recipient_user_id', '=', recipient)
    .where(sql<string>`entity_ref->>'id'`, '=', entityId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
