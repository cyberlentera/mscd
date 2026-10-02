// Multi-factor authentication (build plan F.5, F.3): TOTP factors sealed with `platform.key` (AAD `mfa:<userId>`),
// replay protection by the last accepted step, ten single-use recovery codes, enrolment and re-enrolment with a
// recent proof (a session that has not passed the second factor replaces a confirmed factor only with its current
// code), and the per-user second-factor lock across sessions: 10 consecutive failures lock the second factor
// for 15 minutes, doubling with every further lock up to 24 hours; the level decays by one per 24 hours without a
// lock. Every failure audits `auth.mfa_failed`, every lock `auth.mfa_locked` and emails the user.
import { Injectable } from '@nestjs/common';
import type { LoginResponse, MfaEnrolConfirmResponse, MfaEnrolStartRequest, MfaEnrolStartResponse, MfaVerifyRequest } from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { sql } from 'kysely';
import { RateLimitedError, UnauthenticatedError } from '../../common/problems';
import type { Trx } from '../../common/tokens';
import { AccountMailer } from './account-mailer';
import { checkPassword } from './credentials';
import { IdentityInfra } from './identity-infra';
import { hashSecret, verifySecret } from './password-hasher';
import { newRecoveryCodes, recoveryCodeKey, RECOVERY_CODE_COUNT } from './recovery-codes';
import { SessionService, type CurrentSession, type IssuedSession, type SessionRow } from './session.service';
import { principalUser, SignInResponder, type UserColumns } from './sign-in-responder';
import { base32Encode, matchTotp, newTotpSecret, otpauthUrl } from './totp';

/** Issuer shown by authenticator apps (F.5). */
export const TOTP_ISSUER = 'MSCD';
/** Consecutive second-factor failures of a user that lock the second factor (F.3). */
export const MFA_FAILURES_BEFORE_LOCK = 10;
/** First lock length; each further lock doubles it (F.3). */
export const MFA_LOCK_BASE_MS = 15 * 60_000;
/** Longest lock (F.3). */
export const MFA_LOCK_MAX_MS = 24 * 3_600_000;
/** The lock level drops by one per this time without a lock (F.3). */
export const MFA_LEVEL_DECAY_MS = 24 * 3_600_000;
/** Second-factor failures of one session that revoke it (F.3). */
export const SESSION_MFA_FAILURE_LIMIT = 10;
/** A password or TOTP proof this recent replaces the proof of a re-enrolment or an identity link (F.5, F.8). */
export const RECENT_PROOF_MS = 5 * 60_000;

function isRecent(at: Date | null, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() <= RECENT_PROOF_MS && at.getTime() <= now.getTime() + 60_000;
}

/** True when the session verified a password or a second factor within the last 5 minutes (F.5). */
export function hasRecentProof(session: Pick<SessionRow, 'password_at' | 'mfa_at'>, now: Date): boolean {
  return isRecent(session.password_at, now) || isRecent(session.mfa_at, now);
}

/** True when the session verified the second factor within the last 5 minutes. */
export function hasRecentSecondFactorProof(session: Pick<SessionRow, 'mfa_at'>, now: Date): boolean {
  return isRecent(session.mfa_at, now);
}

/** What starting an enrolment asks for (F.5): nothing, the current code or the password, or only the current code. */
export type EnrolmentProof = 'none' | 'code_or_password' | 'code';

/**
 * The proof an enrolment needs (F.5). An active session (re-enrolment) gives the current code or the password unless
 * it proved one of them in the last 5 minutes. A session that has not passed the second factor (`mfa_enrolment`)
 * needs nothing while the user has no confirmed factor; once the user has one (confirmed in another session
 * meanwhile), enrolling would replace it, and the session must give the current code unless it proved it in the last
 * 5 minutes: its password proves nothing the sign-in did not, so a password alone never replaces a factor.
 */
export function enrolmentProofNeeded(session: Pick<SessionRow, 'state' | 'password_at' | 'mfa_at'>, userHasFactor: boolean, now: Date): EnrolmentProof {
  if (session.state === 'active') return hasRecentProof(session, now) ? 'none' : 'code_or_password';
  if (!userHasFactor) return 'none';
  return hasRecentSecondFactorProof(session, now) ? 'none' : 'code';
}

/** Lock length of a lock at `level` (0 for the first). */
export function mfaLockDuration(level: number): number {
  return Math.min(MFA_LOCK_BASE_MS * 2 ** Math.max(0, level), MFA_LOCK_MAX_MS);
}

/** The lock level after decay: one level less per 24 hours since the last lock ended. */
export function decayedLockLevel(level: number, lastLockedUntil: Date | null, now: Date): number {
  if (!lastLockedUntil || level <= 0) return Math.max(0, level);
  const since = now.getTime() - lastLockedUntil.getTime();
  if (since <= 0) return level;
  return Math.max(0, level - Math.floor(since / MFA_LEVEL_DECAY_MS));
}

/** Key of a session's second-factor failure count in `platform.rate_limit_bucket` (F.3). */
export function sessionFailureKey(idHash: Buffer): string {
  return `mfa-fail:${idHash.toString('hex').slice(0, 40)}`;
}

/**
 * Adds one second-factor failure of a session to its fixed-window count in `platform.rate_limit_bucket` and returns
 * the failures so far. It runs in the caller's transaction on purpose: the caller holds the user's row lock, and
 * asking the pool for a second connection while holding it lets `database.pool_max` concurrent failures take every
 * connection and stall the api (each waits for a connection or for the row lock held by another).
 */
export async function countSessionFailureIn(trx: Trx, key: string, windowMs: number): Promise<number> {
  const window = Math.max(1, Math.trunc(windowMs));
  const { rows } = await sql<{ hits: number }>`
    insert into platform.rate_limit_bucket as b (key, window_start, hits, expires_at)
    values (${key}, clock_timestamp(), 1, clock_timestamp() + ${window} * interval '1 millisecond')
    on conflict (key) do update set
      window_start = case when b.expires_at <= clock_timestamp() then clock_timestamp() else b.window_start end,
      hits = case when b.expires_at <= clock_timestamp() then 1 else b.hits + 1 end,
      expires_at = case when b.expires_at <= clock_timestamp()
                        then clock_timestamp() + ${window} * interval '1 millisecond' else b.expires_at end
    returning hits`.execute(trx);
  return Number(rows[0]!.hits);
}

export type SecondFactorProof = { code: string } | { recoveryCode: string };

export type SecondFactorOutcome =
  | { kind: 'ok'; method: 'totp' | 'recovery_code' }
  /** Wrong code; `lockedUntil` is set when this failure locked the second factor. */
  | { kind: 'failed'; lockedUntil: Date | null }
  /** The second factor is locked: the code was not checked (429). */
  | { kind: 'locked'; until: Date };

/** What an audit entry of a second-factor event needs besides the user. */
export interface SecondFactorContext {
  organizationId: string | null;
}

const USER_COLUMNS = ['id', 'handle', 'email', 'display_name', 'job_title', 'kind'] as const;

/** The audit actor of a user acting on their own sign-in. */
function actorOf(userId: string, kind: string): { userId: string; kind: 'user' | 'guest' } {
  return { userId, kind: kind === 'guest' ? 'guest' : 'user' };
}

function lockedError(until: Date, now: Date): RateLimitedError {
  return new RateLimitedError(Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)), 'Two-step sign-in is locked after too many wrong codes; try again later');
}

function wrongCode(): UnauthenticatedError {
  return new UnauthenticatedError({ messageKey: 'auth.mfa_invalid', detail: 'The code is not valid' });
}

function factorCodeRequired(): UnauthenticatedError {
  return new UnauthenticatedError({
    messageKey: 'auth.proof_required',
    detail: 'Your account already has an authenticator: enter its current code to replace it, or sign in again',
  });
}

@Injectable()
export class MfaService {
  constructor(
    private readonly infra: IdentityInfra,
    private readonly sessions: SessionService,
    private readonly responder: SignInResponder,
    private readonly mailer: AccountMailer,
  ) {}

  /** True when the user has a confirmed second factor. */
  async hasConfirmedFactor(trx: Trx, userId: string): Promise<boolean> {
    const row = await trx
      .selectFrom('platform.mfa_factor')
      .select('id')
      .where('user_id', '=', userId)
      .where('confirmed_at', 'is not', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Checks a TOTP or recovery code of a user with the per-user lock (F.3, F.5) and records the result in `trx`:
   * failures, locks, audit entries and the emails (after commit). The caller commits `trx` also when the check
   * failed, so the failure counts.
   */
  async checkSecondFactor(trx: Trx, userId: string, proof: SecondFactorProof, context: SecondFactorContext): Promise<SecondFactorOutcome> {
    const now = this.infra.clock.now();
    const user = await trx
      .selectFrom('platform.app_user')
      .select(['id', 'email', 'kind', 'mfa_failed_count', 'mfa_lock_level', 'mfa_locked_until'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (user.mfa_locked_until && user.mfa_locked_until.getTime() > now.getTime()) return { kind: 'locked', until: user.mfa_locked_until };

    const method = 'code' in proof ? 'totp' : 'recovery_code';
    const recovery = 'code' in proof ? null : await this.useRecoveryCode(trx, userId, proof.recoveryCode, now);
    const ok = 'code' in proof ? await this.useTotp(trx, userId, proof.code, now) : recovery !== null;
    const actor = actorOf(userId, user.kind);
    if (ok) {
      if (user.mfa_failed_count !== 0) await trx.updateTable('platform.app_user').set({ mfa_failed_count: 0 }).where('id', '=', userId).execute();
      if (recovery !== null) {
        await this.infra.audit.record(trx, {
          action: 'auth.recovery_code_used',
          actor,
          organizationId: context.organizationId,
          entityType: 'user',
          entityId: userId,
          after: { remainingCodes: recovery.remaining },
        });
        this.mailer.sendAfterCommit(trx, {
          to: { email: user.email, userId },
          template: { name: 'recovery_code_used', link: this.mailer.appLink('/'), remaining: recovery.remaining },
        });
      }
      return { kind: 'ok', method };
    }

    const failures = user.mfa_failed_count + 1;
    await this.infra.audit.record(trx, {
      action: 'auth.mfa_failed',
      actor,
      organizationId: context.organizationId,
      entityType: 'user',
      entityId: userId,
      after: { method, consecutiveFailures: failures },
    });
    if (failures < MFA_FAILURES_BEFORE_LOCK) {
      await trx.updateTable('platform.app_user').set({ mfa_failed_count: failures }).where('id', '=', userId).execute();
      return { kind: 'failed', lockedUntil: null };
    }
    const level = decayedLockLevel(user.mfa_lock_level, user.mfa_locked_until, now);
    const duration = mfaLockDuration(level);
    const until = new Date(now.getTime() + duration);
    await trx
      .updateTable('platform.app_user')
      .set({ mfa_failed_count: 0, mfa_lock_level: level + 1, mfa_locked_until: until })
      .where('id', '=', userId)
      .execute();
    await this.infra.audit.record(trx, {
      action: 'auth.mfa_locked',
      actor,
      organizationId: context.organizationId,
      entityType: 'user',
      entityId: userId,
      after: { lockedUntil: until.toISOString(), lockLevel: level + 1, lockMinutes: Math.round(duration / 60_000) },
    });
    this.mailer.sendAfterCommit(trx, {
      to: { email: user.email, userId },
      template: { name: 'mfa_locked', link: this.mailer.appLink('/login'), until: `${until.toISOString().slice(0, 16).replace('T', ' ')} UTC` },
    });
    return { kind: 'failed', lockedUntil: until };
  }

  /** `POST /auth/mfa/verify` (F.5): the second factor of an `mfa_pending` session; success rotates it to `active`. */
  async verify(current: CurrentSession, reply: FastifyReply, body: MfaVerifyRequest): Promise<LoginResponse> {
    const row = current.row;
    const userId = row.user_id;
    const now = this.infra.clock.now();
    const proof: SecondFactorProof = 'code' in body ? { code: body.code } : { recoveryCode: body.recoveryCode };
    const outcome = await this.infra.scope.withPlatform(
      async (trx) => {
        const result = await this.checkSecondFactor(trx, userId, proof, { organizationId: row.auth_org_id });
        if (result.kind !== 'ok') {
          if (result.kind === 'failed') await this.countSessionFailure(trx, row, now);
          return { result, issued: null, user: null };
        }
        const issued = await this.sessions.rotate(trx, row, { state: 'active', mfaAt: now });
        const user = await this.activate(trx, issued, result.method);
        return { result, issued, user };
      },
      { scope: 'auth', userId, orgId: row.auth_org_id },
    );
    if (outcome.result.kind === 'locked') throw lockedError(outcome.result.until, now);
    if (!outcome.issued || !outcome.user) throw wrongCode();
    return this.responder.respond(reply, outcome.issued, principalUser(outcome.user));
  }

  /**
   * `POST /auth/mfa/enrol/start` (F.5): a new TOTP secret, shown once. The proof follows `enrolmentProofNeeded`,
   * decided under the user's row lock: none for the first factor of an `mfa_enrolment` session; from an active
   * session (re-enrolment) the current code or the password unless the session proved one of them in the last 5
   * minutes; from an `mfa_enrolment` session of a user who has a confirmed factor (confirmed in another session) only
   * the current code.
   */
  async startEnrolment(current: CurrentSession, body: MfaEnrolStartRequest): Promise<MfaEnrolStartResponse> {
    const row = current.row;
    const userId = row.user_id;
    const now = this.infra.clock.now();
    const secret = newTotpSecret();
    const sealed = await this.infra.secrets.seal(secret, { purpose: 'mfa', userId });
    const outcome = await this.infra.scope.withPlatform(
      async (trx): Promise<{ error: Error | null; email: string }> => {
        const user = await trx
          .selectFrom('platform.app_user')
          .select(['id', 'email', 'password_hash', 'failed_login_count', 'locked_until'])
          .where('id', '=', userId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        // A confirmation in another session may have revoked this one after the resolver read it.
        if (!(await this.sessions.isOpen(trx, row.id_hash))) return { error: new UnauthenticatedError(), email: user.email };
        const needed = enrolmentProofNeeded(row, await this.hasConfirmedFactor(trx, userId), now);
        if (needed !== 'none') {
          const error = await this.checkProof(trx, row, user, body, now, needed);
          if (error) return { error, email: user.email };
        }
        await trx
          .updateTable('platform.mfa_factor')
          .set({ deleted_at: now })
          .where('user_id', '=', userId)
          .where('confirmed_at', 'is', null)
          .where('deleted_at', 'is', null)
          .execute();
        await trx.insertInto('platform.mfa_factor').values({ user_id: userId, kind: 'totp', secret_sealed: sealed, label: 'Authenticator app' }).execute();
        return { error: null, email: user.email };
      },
      { scope: 'auth', userId, orgId: row.auth_org_id },
    );
    if (outcome.error) throw outcome.error;
    const secretBase32 = base32Encode(secret);
    return { secret: secretBase32, otpauthUrl: otpauthUrl(TOTP_ISSUER, outcome.email, secretBase32), issuer: TOTP_ISSUER, account: outcome.email };
  }

  /**
   * `POST /auth/mfa/enrol/confirm` (F.5): the first code of the new secret confirms it, replaces an older factor,
   * issues ten recovery codes (shown once) and rotates the session to `active`. On re-enrolment every other session
   * of the user is revoked (`mfa_reenrolled`); on a first enrolment the user's other sessions still in
   * `mfa_enrolment` are (`mfa_enrolled`), so a session signed in with the password alone cannot later replace the
   * factor. Under the user's row lock a session that has not passed the second factor and would replace a confirmed
   * factor must have proved the current code in the last 5 minutes (401 `auth.proof_required`).
   */
  async confirmEnrolment(current: CurrentSession, reply: FastifyReply, code: string): Promise<MfaEnrolConfirmResponse> {
    const row = current.row;
    const userId = row.user_id;
    const now = this.infra.clock.now();
    // Check the code before the costly hashing of the recovery codes, then again under the user lock.
    const pending = await this.infra.scope.withPlatform((trx) => this.pendingFactor(trx, userId), { scope: 'auth', userId });
    if (!pending || (await this.matchPending(pending, userId, code, now)) === null) throw wrongCode();
    const codes = newRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashSecret(recoveryCodeKey(c))));

    const outcome = await this.infra.scope.withPlatform(
      async (trx): Promise<{ error: Error } | { error: null; issued: IssuedSession; user: UserColumns }> => {
        const owner = await trx.selectFrom('platform.app_user').select(['id', 'kind']).where('id', '=', userId).forUpdate().executeTakeFirstOrThrow();
        const actor = actorOf(userId, owner.kind);
        if (row.state !== 'active' && enrolmentProofNeeded(row, await this.hasConfirmedFactor(trx, userId), now) !== 'none') {
          return { error: factorCodeRequired() };
        }
        const factor = await this.pendingFactor(trx, userId);
        const step = factor ? await this.matchPending(factor, userId, code, now) : null;
        if (!factor || step === null) return { error: wrongCode() };
        const replaced = await trx
          .updateTable('platform.mfa_factor')
          .set({ deleted_at: now })
          .where('user_id', '=', userId)
          .where('confirmed_at', 'is not', null)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        const wasReplaced = Number(replaced.numUpdatedRows) > 0;
        await trx.updateTable('platform.mfa_factor').set({ confirmed_at: now, last_used_step: String(step) }).where('id', '=', factor.id).execute();
        await trx
          .updateTable('platform.mfa_recovery_code')
          .set({ deleted_at: now })
          .where('user_id', '=', userId)
          .where('used_at', 'is', null)
          .where('deleted_at', 'is', null)
          .execute();
        await trx
          .insertInto('platform.mfa_recovery_code')
          .values(hashes.map((code_hash) => ({ user_id: userId, code_hash })))
          .execute();
        const issued = await this.sessions.rotate(trx, row, { state: 'active', mfaAt: now });
        // Re-enrolment: every other session. First enrolment: the other sessions that were waiting to enrol, which
        // would otherwise replace this factor later without proving it.
        const reason = wasReplaced ? 'mfa_reenrolled' : 'mfa_enrolled';
        const revoked = await this.sessions.revokeUserSessions(trx, userId, reason, {
          except: issued.row.id_hash,
          ...(wasReplaced ? {} : { states: ['mfa_enrolment'] as const }),
        });
        if (revoked > 0) {
          await this.infra.audit.record(trx, {
            action: 'auth.session_revoked',
            actor,
            organizationId: row.auth_org_id,
            entityType: 'user',
            entityId: userId,
            after: { reason, sessions: revoked },
          });
        }
        await this.infra.audit.record(trx, {
          action: 'auth.mfa_enrolled',
          actor,
          organizationId: row.auth_org_id,
          entityType: 'user',
          entityId: userId,
          after: { kind: 'totp', replaced: wasReplaced, recoveryCodes: RECOVERY_CODE_COUNT },
        });
        const user = row.state === 'active' ? await this.userColumns(trx, userId) : await this.activate(trx, issued, 'totp_enrolment');
        this.mailer.sendAfterCommit(trx, {
          to: { email: user.email, userId },
          template: { name: wasReplaced ? 'mfa_replaced' : 'mfa_enrolled', link: this.mailer.appLink('/') },
        });
        return { error: null, issued, user };
      },
      { scope: 'auth', userId, orgId: row.auth_org_id },
    );
    if (outcome.error) throw outcome.error;
    const response = await this.responder.respond(reply, outcome.issued, principalUser(outcome.user));
    if (response.status !== 'ok' || !response.me) throw new Error('An enrolled session must be active');
    return { recoveryCodes: codes, me: response.me };
  }

  /**
   * Removes the second factor of a user (F.5 MFA reset by a Tenant Admin or the platform operator): factors and
   * recovery codes are deleted, the second-factor lock is cleared, every session of the user is revoked, the reset is
   * audited (`auth.mfa_reset`) and the user is emailed after commit. Runs in the caller's transaction; the caller
   * checks who may reset (F.6).
   */
  async resetFactor(trx: Trx, userId: string, options: { organizationId: string | null; actor?: { userId: string | null; kind: 'user' | 'operator' | 'system' } }): Promise<void> {
    const now = this.infra.clock.now();
    const user = await trx.selectFrom('platform.app_user').select(['id', 'email']).where('id', '=', userId).forUpdate().executeTakeFirstOrThrow();
    await trx.updateTable('platform.mfa_factor').set({ deleted_at: now }).where('user_id', '=', userId).where('deleted_at', 'is', null).execute();
    await trx
      .updateTable('platform.mfa_recovery_code')
      .set({ deleted_at: now })
      .where('user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .execute();
    await trx.updateTable('platform.app_user').set({ mfa_failed_count: 0, mfa_locked_until: null }).where('id', '=', userId).execute();
    const revoked = await this.sessions.revokeUserSessions(trx, userId, 'mfa_reset');
    await this.infra.audit.record(trx, {
      action: 'auth.mfa_reset',
      ...(options.actor ? { actor: options.actor } : {}),
      organizationId: options.organizationId,
      entityType: 'user',
      entityId: userId,
      after: { sessionsRevoked: revoked },
    });
    this.mailer.sendAfterCommit(trx, { to: { email: user.email, userId }, template: { name: 'mfa_reset', link: this.mailer.appLink('/login') } });
  }

  /**
   * Marks a session active after its second factor (or first enrolment): audits `auth.login` and stamps the user's
   * last sign-in. Returns the user's columns for the response.
   */
  private async activate(trx: Trx, issued: IssuedSession, secondFactor: string): Promise<UserColumns> {
    const now = this.infra.clock.now();
    const row = issued.row;
    const user = await trx
      .updateTable('platform.app_user')
      .set({ last_login_at: now })
      .where('id', '=', row.user_id)
      .returning([...USER_COLUMNS])
      .executeTakeFirstOrThrow();
    // F.8 step 5: an SSO sign-in that ends at the local TOTP step audits the provider and the subject too, as a
    // sign-in with an IdP proof of MFA does. The session keeps no subject; the identity used is the one the callback
    // stamped (`user_identity.last_login_at`) when it created this session.
    const identity = row.identity_provider_id
      ? await trx
          .selectFrom('platform.user_identity as i')
          .innerJoin('platform.identity_provider as p', 'p.id', 'i.identity_provider_id')
          .select(['i.subject', 'p.slug'])
          .where('i.identity_provider_id', '=', row.identity_provider_id)
          .where('i.user_id', '=', row.user_id)
          .orderBy(sql`i.last_login_at desc nulls last`)
          .orderBy('i.linked_at', 'desc')
          .executeTakeFirst()
      : undefined;
    await this.infra.audit.record(trx, {
      action: 'auth.login',
      actor: { userId: row.user_id, kind: user.kind === 'guest' ? 'guest' : 'user' },
      organizationId: row.auth_org_id,
      entityType: 'user',
      entityId: row.user_id,
      after: {
        method: row.auth_method,
        secondFactor,
        ...(row.identity_provider_id ? { identityProviderId: row.identity_provider_id } : {}),
        ...(identity ? { provider: identity.slug, subject: identity.subject } : {}),
        ...(row.amr.length > 0 ? { amr: row.amr } : {}),
        ...(row.organization_id ? { organizationId: row.organization_id } : {}),
      },
    });
    return user;
  }

  private async userColumns(trx: Trx, userId: string): Promise<UserColumns> {
    return trx.selectFrom('platform.app_user').select([...USER_COLUMNS]).where('id', '=', userId).executeTakeFirstOrThrow();
  }

  /**
   * Enrolment proof (F.5): the current TOTP code (with the lock) or, when `accepted` allows it, the password (with
   * the account lockout). A password given where only the code counts is not checked.
   */
  private async checkProof(
    trx: Trx,
    row: SessionRow,
    user: { id: string; password_hash: string | null; failed_login_count: number; locked_until: Date | null },
    body: MfaEnrolStartRequest,
    now: Date,
    accepted: Exclude<EnrolmentProof, 'none'>,
  ): Promise<Error | null> {
    if ('currentCode' in body) {
      const result = await this.checkSecondFactor(trx, user.id, { code: body.currentCode }, { organizationId: row.auth_org_id });
      if (result.kind === 'locked') return lockedError(result.until, now);
      if (result.kind === 'failed') return new UnauthenticatedError({ messageKey: 'auth.proof_invalid', detail: 'The current code is not valid' });
      await this.sessions.touchProof(trx, row.id_hash, { mfaAt: now });
      return null;
    }
    if (accepted === 'code') return factorCodeRequired();
    if ('password' in body) {
      const result = await checkPassword(trx, user, body.password, now);
      if (result.kind !== 'ok') return new UnauthenticatedError({ messageKey: 'auth.proof_invalid', detail: 'The password is not valid' });
      await this.sessions.touchProof(trx, row.id_hash, { passwordAt: now });
      return null;
    }
    return new UnauthenticatedError({ messageKey: 'auth.proof_required', detail: 'Enter your current code or your password to replace the authenticator' });
  }

  /** Counts a second-factor failure of one session in the caller's transaction; the 10th revokes it (F.3). */
  private async countSessionFailure(trx: Trx, row: SessionRow, now: Date): Promise<void> {
    const window = Math.max(60_000, row.absolute_expires_at.getTime() - now.getTime());
    const failures = await countSessionFailureIn(trx, sessionFailureKey(row.id_hash), window);
    if (failures < SESSION_MFA_FAILURE_LIMIT) return;
    if (await this.sessions.revoke(trx, row.id_hash, 'mfa_failures')) {
      await this.infra.audit.record(trx, {
        action: 'auth.session_revoked',
        actor: { userId: row.user_id, kind: row.auth_method === 'guest' ? 'guest' : 'user' },
        organizationId: row.auth_org_id,
        entityType: 'user',
        entityId: row.user_id,
        after: { reason: 'mfa_failures', sessions: 1 },
      });
    }
  }

  private async pendingFactor(trx: Trx, userId: string): Promise<{ id: string; secret_sealed: string } | undefined> {
    return trx
      .selectFrom('platform.mfa_factor')
      .select(['id', 'secret_sealed'])
      .where('user_id', '=', userId)
      .where('confirmed_at', 'is', null)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }

  private async matchPending(factor: { secret_sealed: string }, userId: string, code: string, now: Date): Promise<number | null> {
    const secret = await this.infra.secrets.open(factor.secret_sealed, { purpose: 'mfa', userId });
    return matchTotp(secret, code, now);
  }

  /** Accepts a TOTP code of the confirmed factor once (F.5 replay protection); false when wrong or replayed. */
  private async useTotp(trx: Trx, userId: string, code: string, now: Date): Promise<boolean> {
    const factor = await trx
      .selectFrom('platform.mfa_factor')
      .select(['id', 'secret_sealed', 'last_used_step'])
      .where('user_id', '=', userId)
      .where('confirmed_at', 'is not', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!factor) return false;
    const secret = await this.infra.secrets.open(factor.secret_sealed, { purpose: 'mfa', userId });
    const step = matchTotp(secret, code, now, { lastUsedStep: factor.last_used_step === null ? null : Number(factor.last_used_step) });
    if (step === null) return false;
    const updated = await trx
      .updateTable('platform.mfa_factor')
      .set({ last_used_step: String(step) })
      .where('id', '=', factor.id)
      .where((eb) => eb.or([eb('last_used_step', 'is', null), eb('last_used_step', '<', String(step))]))
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  /** Uses one recovery code (F.5); null when no unused code matches, else the number of codes left. */
  private async useRecoveryCode(trx: Trx, userId: string, code: string, now: Date): Promise<{ remaining: number } | null> {
    const rows = await trx
      .selectFrom('platform.mfa_recovery_code')
      .select(['id', 'code_hash'])
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .where('deleted_at', 'is', null)
      .execute();
    const key = recoveryCodeKey(code);
    const matches = await Promise.all(rows.map((r) => verifySecret(r.code_hash, key)));
    const index = matches.indexOf(true);
    if (index < 0) return null;
    const used = await trx
      .updateTable('platform.mfa_recovery_code')
      .set({ used_at: now })
      .where('id', '=', rows[index]!.id)
      .where('used_at', 'is', null)
      .executeTakeFirst();
    if (Number(used.numUpdatedRows) !== 1) return null;
    return { remaining: rows.length - 1 };
  }
}
