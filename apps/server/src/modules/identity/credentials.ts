// Password checks shared by sign-in, password change and re-enrolment proof (build plan F.3, F.4): argon2id
// verification, the account lockout after 10 consecutive wrong passwords (15 minutes, `locked_until`) and the
// rehash of hashes made with older parameters.
import type { Trx } from '../../common/tokens';
import { hashSecret, needsRehash, verifyAgainstNothing, verifySecret } from './password-hasher';

/** Consecutive wrong passwords that lock the account (F.3). */
export const LOGIN_FAILURES_BEFORE_LOCK = 10;
/** Length of an account lock (F.3). */
export const LOGIN_LOCK_MS = 15 * 60_000;

/** The `app_user` columns a password check reads. */
export interface PasswordAccount {
  id: string;
  password_hash: string | null;
  failed_login_count: number;
  locked_until: Date | null;
}

export type PasswordCheck =
  | { kind: 'ok' }
  /** Wrong password; `lockedUntil` is set when this failure locked the account. */
  | { kind: 'wrong'; lockedUntil: Date | null }
  /** The account is locked: the password was not considered. */
  | { kind: 'locked'; until: Date }
  /** The account has no password (invited, SSO or guest account). */
  | { kind: 'no_password' };

/**
 * Checks a password of an account whose row the caller locked (`FOR UPDATE`) in `trx`, and records the result:
 * a wrong password counts towards the lock, a right one clears the count and rehashes an outdated hash. The hash
 * is always verified, also for a locked account, so the answer takes the same time.
 */
export async function checkPassword(trx: Trx, account: PasswordAccount, password: string, now: Date): Promise<PasswordCheck> {
  if (!account.password_hash) {
    await verifyAgainstNothing(password);
    return { kind: 'no_password' };
  }
  const matches = await verifySecret(account.password_hash, password);
  if (account.locked_until && account.locked_until.getTime() > now.getTime()) return { kind: 'locked', until: account.locked_until };
  if (!matches) {
    const count = account.failed_login_count + 1;
    if (count >= LOGIN_FAILURES_BEFORE_LOCK) {
      const until = new Date(now.getTime() + LOGIN_LOCK_MS);
      await trx.updateTable('platform.app_user').set({ failed_login_count: 0, locked_until: until }).where('id', '=', account.id).execute();
      return { kind: 'wrong', lockedUntil: until };
    }
    await trx.updateTable('platform.app_user').set({ failed_login_count: count }).where('id', '=', account.id).execute();
    return { kind: 'wrong', lockedUntil: null };
  }
  const changes: { failed_login_count?: number; locked_until?: null; password_hash?: string } = {};
  if (account.failed_login_count !== 0) changes.failed_login_count = 0;
  if (account.locked_until !== null) changes.locked_until = null;
  if (needsRehash(account.password_hash)) changes.password_hash = await hashSecret(password);
  if (Object.keys(changes).length > 0) await trx.updateTable('platform.app_user').set(changes).where('id', '=', account.id).execute();
  return { kind: 'ok' };
}
