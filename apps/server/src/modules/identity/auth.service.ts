// Local sign-in, logout and passwords (build plan F.1, F.3, F.4, D.3 "System, session and identity"). Every
// failure of a sign-in answers the same 401, whether the email is unknown, the password wrong, the account
// disabled or locked; only a correct password of a user whose organisations require single sign-on learns that
// (`auth.sso_required` with the providers to use). Password reset links carry their token in the URL fragment,
// expire after 30 minutes, work once, and revoke every session of the user.
import { Injectable } from '@nestjs/common';
import type { LoginRequest, LoginResponse, PasswordChangeRequest, PasswordResetConfirm, PasswordResetRequest } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { MscdConfig } from '../../config/mscd-config';
import { ProblemError, UnauthenticatedError, ValidationError } from '../../common/problems';
import type { Trx } from '../../common/tokens';
import { AccountMailer } from './account-mailer';
import { checkPassword } from './credentials';
import { IdentityInfra } from './identity-infra';
import { decideLocalLogin, providerMethods } from './local-login-policy';
import { MfaService } from './mfa.service';
import { hashSecret, verifyAgainstNothing } from './password-hasher';
import { passwordProblems } from './password-policy';
import { SessionService, type CurrentSession } from './session.service';
import { principalUser, SignInResponder } from './sign-in-responder';
import { randomToken, sha256 } from './tokens';

/** Validity of a password reset link (F.4). */
export const RESET_TOKEN_TTL_MS = 30 * 60_000;

/** The one answer of every failed local sign-in (D.3: no account enumeration). */
export function invalidCredentials(): UnauthenticatedError {
  return new UnauthenticatedError({ messageKey: 'auth.invalid_credentials', detail: 'The email or password is not correct, or the account cannot sign in now' });
}

/** 400 `validation` for a link token that is unknown, used or expired. */
export function invalidLinkToken(messageKey: string, what: string): ProblemError {
  return new ProblemError('validation', {
    detail: `The ${what} link is not valid or has expired`,
    messageKey,
    errors: [{ path: 'body.token', message: `The ${what} link is not valid or has expired` }],
  });
}

const LOGIN_COLUMNS = [
  'id',
  'handle',
  'email',
  'display_name',
  'job_title',
  'kind',
  'status',
  'password_hash',
  'failed_login_count',
  'locked_until',
  'mfa_required',
] as const;

/** Lower-cased, trimmed email (accounts are unique by `lower(email)`, C.4). */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  constructor(
    private readonly config: MscdConfig,
    private readonly infra: IdentityInfra,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly responder: SignInResponder,
    private readonly mailer: AccountMailer,
  ) {}

  /** True when a local sign-in of this user must pass a second factor (F.5; the profile can only add the need). */
  secondFactorRequired(user: { mfa_required: boolean }): boolean {
    return user.mfa_required || this.config.profile.identity.local.mfa_required;
  }

  /** `POST /auth/login` (F.4): password, lockout, local sign-in policy, then a session in the next state. */
  async login(request: FastifyRequest, reply: FastifyReply, body: LoginRequest): Promise<LoginResponse> {
    const email = normaliseEmail(body.email);
    const presented = this.sessions.readCookie(request);
    const now = this.infra.clock.now();
    const outcome = await this.infra.scope.withPlatform(
      async (trx) => {
        const user = await trx
          .selectFrom('platform.app_user')
          .select([...LOGIN_COLUMNS])
          .where(sql<string>`lower(email)`, '=', email)
          .where('kind', '<>', 'guest')
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!user) {
          await verifyAgainstNothing(body.password);
          return { kind: 'failed' as const };
        }
        const check = await checkPassword(trx, user, body.password, now);
        if (check.kind !== 'ok' || user.status !== 'active') {
          const reason =
            user.status !== 'active' ? `account_${user.status}` : check.kind === 'locked' ? 'locked' : check.kind === 'no_password' ? 'no_password' : 'wrong_password';
          await this.infra.audit.record(trx, {
            action: 'auth.login_failed',
            actor: { userId: null, kind: 'user' },
            organizationId: await this.defaultOrganisation(trx, user.id),
            entityType: 'user',
            entityId: user.id,
            after: {
              method: 'local',
              reason,
              ...(check.kind === 'wrong' && check.lockedUntil ? { lockedUntil: check.lockedUntil.toISOString() } : {}),
            },
          });
          return { kind: 'failed' as const };
        }
        const decision = await decideLocalLogin(trx, user.id);
        if (!decision.allowed) {
          await this.infra.audit.record(trx, {
            action: 'auth.login_failed',
            actor: { userId: null, kind: 'user' },
            organizationId: decision.memberOrgIds[0] ?? null,
            entityType: 'user',
            entityId: user.id,
            after: { method: 'local', reason: 'sso_required' },
          });
          return { kind: 'sso' as const, methods: await providerMethods(trx, decision.memberOrgIds) };
        }
        const orgId = decision.allowed.orgId;
        const state = !this.secondFactorRequired(user) ? 'active' : (await this.mfa.hasConfirmedFactor(trx, user.id)) ? 'mfa_pending' : 'mfa_enrolment';
        if (presented) await this.sessions.revoke(trx, sha256(presented), 'signed_in_again');
        const issued = await this.sessions.create(trx, {
          userId: user.id,
          organizationId: orgId,
          authOrgId: orgId,
          state,
          authMethod: 'local',
          passwordAt: now,
          remember: body.remember,
        });
        if (state === 'active') await this.recordLogin(trx, user.id, orgId, now);
        return { kind: 'ok' as const, issued, user };
      },
      { scope: 'auth' },
    );
    if (outcome.kind === 'failed') throw invalidCredentials();
    if (outcome.kind === 'sso') {
      throw new UnauthenticatedError({
        messageKey: 'auth.sso_required',
        detail: 'Your organisation requires single sign-on; sign in with one of its identity providers',
        methods: outcome.methods,
      });
    }
    return this.responder.respond(reply, outcome.issued, principalUser(outcome.user));
  }

  /** `POST /auth/logout`: revokes the session and clears the cookie. */
  async logout(current: CurrentSession, reply: FastifyReply): Promise<void> {
    const row = current.row;
    await this.infra.scope.withPlatform(
      async (trx) => {
        if (await this.sessions.revoke(trx, row.id_hash, 'logout')) {
          await this.infra.audit.record(trx, {
            action: 'auth.logout',
            actor: { userId: row.user_id, kind: current.principal.user.kind === 'guest' ? 'guest' : 'user' },
            organizationId: row.auth_org_id,
            entityType: 'user',
            entityId: row.user_id,
            after: { method: row.auth_method },
          });
        }
      },
      { scope: 'auth', userId: row.user_id, orgId: row.auth_org_id },
    );
    this.sessions.clearCookie(reply);
  }

  /**
   * `POST /auth/password/reset-request` (F.4): emails a reset link to an active account that may sign in locally.
   * Nothing tells the caller whether that happened, and the email is sent in the background, so neither the answer
   * nor its timing reveals an account.
   */
  async requestPasswordReset(body: PasswordResetRequest): Promise<void> {
    const email = normaliseEmail(body.email);
    const now = this.infra.clock.now();
    const target = await this.infra.scope.withPlatform(
      async (trx) => {
        const user = await trx
          .selectFrom('platform.app_user')
          .select(['id', 'email'])
          .where(sql<string>`lower(email)`, '=', email)
          .where('kind', '=', 'person')
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!user) return null;
        const decision = await decideLocalLogin(trx, user.id);
        if (!decision.allowed) return null;
        const token = randomToken();
        await trx
          .insertInto('platform.password_reset_token')
          .values({ token_hash: sha256(token), kind: 'reset', user_id: user.id, created_at: now, expires_at: new Date(now.getTime() + RESET_TOKEN_TTL_MS) })
          .execute();
        return { user, token };
      },
      { scope: 'auth' },
    );
    if (!target) return;
    this.mailer.sendInBackground({
      to: { email: target.user.email, userId: target.user.id },
      template: { name: 'password_reset', link: this.mailer.appLink(`/reset-password#token=${target.token}`), minutes: RESET_TOKEN_TTL_MS / 60_000 },
    });
  }

  /** `POST /auth/password/reset` (F.4): sets the new password and revokes every session of the user. */
  async resetPassword(body: PasswordResetConfirm): Promise<void> {
    const now = this.infra.clock.now();
    const error = await this.infra.scope.withPlatform(
      async (trx): Promise<Error | null> => {
        const token = await trx
          .selectFrom('platform.password_reset_token')
          .selectAll()
          .where('token_hash', '=', sha256(body.token))
          .where('kind', '=', 'reset')
          .forUpdate()
          .executeTakeFirst();
        if (!token || token.used_at !== null || token.expires_at.getTime() <= now.getTime()) return invalidLinkToken('auth.reset_invalid', 'password reset');
        const user = await trx
          .selectFrom('platform.app_user')
          .select(['id', 'email', 'handle'])
          .where('id', '=', token.user_id)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!user || !(await decideLocalLogin(trx, user.id)).allowed) return invalidLinkToken('auth.reset_invalid', 'password reset');
        const problems = passwordProblems(body.password, user, 'body.password');
        if (problems.length > 0) return new ValidationError(problems, 'The new password does not meet the password policy');
        await trx
          .updateTable('platform.app_user')
          .set({ password_hash: await hashSecret(body.password), password_changed_at: now, failed_login_count: 0, locked_until: null })
          .where('id', '=', user.id)
          .execute();
        await trx.updateTable('platform.password_reset_token').set({ used_at: now }).where('token_hash', '=', token.token_hash).execute();
        const revoked = await this.sessions.revokeUserSessions(trx, user.id, 'password_reset');
        await this.infra.audit.record(trx, {
          action: 'auth.password_reset',
          actor: { userId: user.id, kind: 'user' },
          organizationId: await this.defaultOrganisation(trx, user.id),
          entityType: 'user',
          entityId: user.id,
          after: { sessionsRevoked: revoked },
        });
        this.mailer.sendAfterCommit(trx, { to: { email: user.email, userId: user.id }, template: { name: 'password_reset_done', link: this.mailer.appLink('/login') } });
        return null;
      },
      { scope: 'auth' },
    );
    if (error) throw error;
  }

  /** `POST /auth/password/change` (F.4): checks the current password, then revokes the user's other sessions. */
  async changePassword(current: CurrentSession, body: PasswordChangeRequest): Promise<void> {
    const row = current.row;
    const now = this.infra.clock.now();
    const error = await this.infra.scope.withPlatform(
      async (trx): Promise<Error | null> => {
        const user = await trx
          .selectFrom('platform.app_user')
          .select(['id', 'email', 'handle', 'password_hash', 'failed_login_count', 'locked_until'])
          .where('id', '=', row.user_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const check = await checkPassword(trx, user, body.currentPassword, now);
        if (check.kind !== 'ok') return new UnauthenticatedError({ messageKey: 'auth.password_invalid', detail: 'The current password is not correct' });
        const problems = passwordProblems(body.newPassword, user, 'body.newPassword');
        if (problems.length > 0) return new ValidationError(problems, 'The new password does not meet the password policy');
        await trx
          .updateTable('platform.app_user')
          .set({ password_hash: await hashSecret(body.newPassword), password_changed_at: now })
          .where('id', '=', user.id)
          .execute();
        await this.sessions.touchProof(trx, row.id_hash, { passwordAt: now });
        const revoked = await this.sessions.revokeUserSessions(trx, user.id, 'password_changed', { except: row.id_hash });
        await this.infra.audit.record(trx, {
          action: 'auth.password_changed',
          actor: { userId: user.id, kind: 'user' },
          organizationId: row.auth_org_id,
          entityType: 'user',
          entityId: user.id,
          after: { sessionsRevoked: revoked },
        });
        this.mailer.sendAfterCommit(trx, { to: { email: user.email, userId: user.id }, template: { name: 'password_changed', link: this.mailer.appLink('/') } });
        return null;
      },
      { scope: 'auth', userId: row.user_id, orgId: row.auth_org_id },
    );
    if (error) throw error;
  }

  /** Audits `auth.login` for a session that became active and stamps the user's last sign-in. */
  async recordLogin(trx: Trx, userId: string, orgId: string | null, now: Date, details: Record<string, unknown> = {}): Promise<void> {
    await trx.updateTable('platform.app_user').set({ last_login_at: now }).where('id', '=', userId).execute();
    await this.infra.audit.record(trx, {
      action: 'auth.login',
      actor: { userId, kind: 'user' },
      organizationId: orgId,
      entityType: 'user',
      entityId: userId,
      after: { method: 'local', ...details },
    });
  }

  /** The user's default active organisation, for the organisation of platform audit entries. */
  private async defaultOrganisation(trx: Trx, userId: string): Promise<string | null> {
    const row = await trx
      .selectFrom('platform.org_membership')
      .select('organization_id')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .orderBy('is_default', 'desc')
      .orderBy('created_at')
      .executeTakeFirst();
    return row?.organization_id ?? null;
  }
}
