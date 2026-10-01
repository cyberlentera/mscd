// Platform scope inside a caller's transaction (build plan F.10, D-31). Sign-in code opens its own transactions with
// `withPlatform`; services of other modules call the session revocations of this module inside their own
// `withTenant` transaction, where `platform.session` shows only the acting user's rows. These helpers switch the
// transaction-local platform scope on for the identity statements and back to what it was, as the audit writer does
// for `platform.audit_log`, so the change and the revocation commit together.
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';

/** Runs `fn` with `app.platform_scope = 'on'` in `trx` and restores the previous value afterwards. */
export async function inPlatformScope<T>(trx: Trx, fn: () => Promise<T>): Promise<T> {
  const { rows } = await sql<{ prev: string }>`select coalesce(current_setting('app.platform_scope', true), '') as prev`.execute(trx);
  const previous = rows[0]?.prev ?? '';
  if (previous === 'on') return fn();
  await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
  const restore = () => sql`select set_config('app.platform_scope', ${previous}, true)`.execute(trx);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    // After a database error the transaction is aborted and rolls back anyway; the original error is what matters.
    await restore().catch(() => undefined);
    throw error;
  }
  await restore();
  return result;
}
