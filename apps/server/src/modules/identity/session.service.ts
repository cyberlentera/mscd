// Server-side sessions (build plan F.1, D-19, D-26). A session is a `platform.session` row referenced by an opaque
// cookie of 32 random bytes; the database keeps only `sha256(value)`. States `mfa_pending`, `mfa_enrolment` and
// `active`; only `active` passes the guard of business routes. Idle timeout 60 minutes, absolute 8 hours, or 12
// hours with "Keep me signed in" (the cookie then gets `Max-Age`); guests 30 minutes and 4 hours. A new session id
// replaces the old row at every step that raises or changes what the session may do (rotation), and the
// revocations of F.1 end the sessions a security change makes untrustworthy.
//
// Other modules use this service for their own sign-in and session changes: OIDC and SAML sign-in (WP-16, WP-19),
// guest access (WP-26), organisation and persona switches and role changes (WP-39), provider and grant revocation.
import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import type { AuthMethod, SessionState } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Selectable } from 'kysely';
import { MscdConfig } from '../../config/mscd-config';
import { UnauthenticatedError } from '../../common/problems';
import { currentRequestContext } from '../../common/request-context';
import type { Principal, PrincipalSession, Trx } from '../../common/tokens';
import type { SessionTable } from '../../db/types/platform';
import { IdentityInfra } from './identity-infra';
import { inPlatformScope } from './platform-scope';
import { csrfTokenFor, RANDOM_TOKEN, randomToken, sha256 } from './tokens';

/** Cookie names (F.1): `__Host-` needs `Secure`, so plain-HTTP demo and test installs use the bare name. */
export const SESSION_COOKIE = '__Host-mscd_session';
export const SESSION_COOKIE_INSECURE = 'mscd_session';

/** `last_seen_at` and `idle_expires_at` are written at most once per minute (F.1). */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

export type SessionRow = Selectable<SessionTable>;

/** `session.revoke_reason` values written by this build (varchar(40)). */
export type SessionRevokeReason =
  | 'logout'
  | 'rotated'
  | 'expired'
  | 'signed_in_again'
  | 'password_changed'
  | 'password_reset'
  | 'mfa_reenrolled'
  | 'mfa_reset'
  | 'mfa_failures'
  | 'user_disabled'
  | 'membership_removed'
  | 'roles_changed'
  | 'grant_revoked'
  | 'idp_disabled';

export interface NewSession {
  userId: string;
  /** Current organisation (D-26); null for a platform operator without a membership. */
  organizationId: string | null;
  /** Organisation whose policy accepted the sign-in (D-26). */
  authOrgId: string | null;
  state: SessionState;
  authMethod: AuthMethod;
  identityProviderId?: string | null;
  /** Auditor grant of a guest session (F.14). */
  authGrantId?: string | null;
  amr?: string[];
  /** Time of a password proof in this sign-in (F.5 recent proof). */
  passwordAt?: Date | null;
  /** Time of a second-factor proof in this sign-in. */
  mfaAt?: Date | null;
  /** "Keep me signed in": persistent cookie and the longer absolute limit (F.1). Ignored for guests. */
  remember?: boolean;
}

/** Fields a rotation may change; everything else is copied from the old row. */
export type SessionChanges = Partial<
  Pick<NewSession, 'organizationId' | 'authOrgId' | 'state' | 'authMethod' | 'identityProviderId' | 'authGrantId' | 'amr' | 'passwordAt' | 'mfaAt'>
>;

/** A session just written, with the values the client receives once. */
export interface IssuedSession {
  /** Cookie value (32 random bytes, base64url). */
  cookieValue: string;
  /** Synchronizer token of the session (F.2). */
  csrfToken: string;
  row: SessionRow;
}

/** The session behind the current request, as the session resolver found it. */
export interface CurrentSession {
  cookieValue: string;
  row: SessionRow;
  principal: Principal;
}

/** Idle and absolute lengths of sessions of one kind (F.1). */
export interface SessionTimeouts {
  idleMs: number;
  absoluteMs: number;
  rememberMs: number;
}

function cut(value: string | null | undefined, length: number): string | null {
  if (!value) return null;
  return value.length > length ? value.slice(0, length) : value;
}

@Injectable()
export class SessionService {
  private readonly current = new WeakMap<FastifyRequest, CurrentSession>();

  constructor(
    private readonly config: MscdConfig,
    private readonly infra: IdentityInfra,
  ) {}

  /** True when cookies carry `Secure` (`security.cookie_secure`). */
  get secureCookies(): boolean {
    return this.config.profile.security.cookie_secure;
  }

  /** Name of the session cookie for this installation (F.1). */
  get cookieName(): string {
    return this.secureCookies ? SESSION_COOKIE : SESSION_COOKIE_INSECURE;
  }

  /** The session cookie value of a request when it has the shape of one, else null. */
  readCookie(request: FastifyRequest): string | null {
    const value = request.cookies?.[this.cookieName];
    return typeof value === 'string' && RANDOM_TOKEN.test(value) ? value : null;
  }

  /** Timeouts for a sign-in method (guests have their own, F.1). */
  timeouts(authMethod: AuthMethod): SessionTimeouts {
    const s = this.config.profile.identity.session;
    const guest = authMethod === 'guest';
    return {
      idleMs: (guest ? s.guest_idle_minutes : s.idle_minutes) * 60_000,
      absoluteMs: (guest ? s.guest_absolute_hours : s.absolute_hours) * 3_600_000,
      rememberMs: (guest ? s.guest_absolute_hours : s.remember_hours) * 3_600_000,
    };
  }

  /** Writes a new session in `trx`. The caller sets the cookie with `setCookie` once the transaction commits. */
  async create(trx: Trx, input: NewSession): Promise<IssuedSession> {
    const now = this.infra.clock.now();
    const timeouts = this.timeouts(input.authMethod);
    const persistent = Boolean(input.remember) && input.authMethod !== 'guest';
    const absolute = new Date(now.getTime() + (persistent ? timeouts.rememberMs : timeouts.absoluteMs));
    return this.insert(trx, now, {
      user_id: input.userId,
      organization_id: input.organizationId,
      auth_org_id: input.authOrgId,
      state: input.state,
      auth_method: input.authMethod,
      identity_provider_id: input.identityProviderId ?? null,
      auth_grant_id: input.authGrantId ?? null,
      amr: input.amr ?? [],
      password_at: input.passwordAt ?? null,
      mfa_at: input.mfaAt ?? null,
      persistent,
      absolute_expires_at: absolute,
    });
  }

  /**
   * Replaces a session by a new id (F.1 rotation): the new row copies the old one with `changes` applied, keeps
   * its absolute expiry and persistence, and the old row is revoked with reason `rotated`. The old row is revoked
   * first: a session that another request already rotated or revoked cannot be rotated again (401), so one session
   * never turns into two.
   */
  async rotate(trx: Trx, old: SessionRow, changes: SessionChanges = {}): Promise<IssuedSession> {
    const now = this.infra.clock.now();
    if (!(await this.revoke(trx, old.id_hash, 'rotated'))) throw new UnauthenticatedError();
    const has = (key: keyof SessionChanges) => Object.hasOwn(changes, key);
    return this.insert(trx, now, {
      user_id: old.user_id,
      organization_id: has('organizationId') ? (changes.organizationId ?? null) : old.organization_id,
      auth_org_id: has('authOrgId') ? (changes.authOrgId ?? null) : old.auth_org_id,
      state: changes.state ?? old.state,
      auth_method: changes.authMethod ?? old.auth_method,
      identity_provider_id: has('identityProviderId') ? (changes.identityProviderId ?? null) : old.identity_provider_id,
      auth_grant_id: has('authGrantId') ? (changes.authGrantId ?? null) : old.auth_grant_id,
      amr: changes.amr ?? old.amr,
      password_at: has('passwordAt') ? (changes.passwordAt ?? null) : old.password_at,
      mfa_at: has('mfaAt') ? (changes.mfaAt ?? null) : old.mfa_at,
      persistent: old.persistent,
      absolute_expires_at: old.absolute_expires_at,
    });
  }

  /** Records a fresh password or second-factor proof on a session (F.5 recent proof). */
  async touchProof(trx: Trx, idHash: Buffer, proof: { passwordAt?: Date; mfaAt?: Date }): Promise<void> {
    const changes = { ...(proof.passwordAt ? { password_at: proof.passwordAt } : {}), ...(proof.mfaAt ? { mfa_at: proof.mfaAt } : {}) };
    if (Object.keys(changes).length === 0) return;
    await inPlatformScope(trx, () => trx.updateTable('platform.session').set(changes).where('id_hash', '=', idHash).execute());
  }

  /** Revokes one session; true when it was still open. */
  async revoke(trx: Trx, idHash: Buffer, reason: SessionRevokeReason): Promise<boolean> {
    const now = this.infra.clock.now();
    const result = await inPlatformScope(trx, () =>
      trx
        .updateTable('platform.session')
        .set({ revoked_at: now, revoke_reason: reason })
        .where('id_hash', '=', idHash)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) > 0;
  }

  /** Revokes every open session of a user, except `except` (the caller's own session); returns how many. */
  async revokeUserSessions(trx: Trx, userId: string, reason: SessionRevokeReason, options: { except?: Buffer | null } = {}): Promise<number> {
    const now = this.infra.clock.now();
    const result = await inPlatformScope(trx, () => {
      let query = trx
        .updateTable('platform.session')
        .set({ revoked_at: now, revoke_reason: reason })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null);
      if (options.except) query = query.where('id_hash', '<>', options.except);
      return query.executeTakeFirst();
    });
    return Number(result.numUpdatedRows);
  }

  /**
   * Revokes the sessions whose current or authenticating organisation is `orgId` (F.1: removal from an organisation
   * or a disabled membership), only those of `userId` when given.
   */
  async revokeOrganisationSessions(trx: Trx, orgId: string, reason: SessionRevokeReason, options: { userId?: string } = {}): Promise<number> {
    const now = this.infra.clock.now();
    const result = await inPlatformScope(trx, () => {
      let query = trx
        .updateTable('platform.session')
        .set({ revoked_at: now, revoke_reason: reason })
        .where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('organization_id', '=', orgId), eb('auth_org_id', '=', orgId)]));
      if (options.userId) query = query.where('user_id', '=', options.userId);
      return query.executeTakeFirst();
    });
    return Number(result.numUpdatedRows);
  }

  /** Revokes the sessions of an auditor grant (F.14 revocation or expiry). */
  async revokeGrantSessions(trx: Trx, grantId: string, reason: SessionRevokeReason = 'grant_revoked'): Promise<number> {
    const now = this.infra.clock.now();
    const result = await inPlatformScope(trx, () =>
      trx
        .updateTable('platform.session')
        .set({ revoked_at: now, revoke_reason: reason })
        .where('auth_grant_id', '=', grantId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows);
  }

  /** Revokes the sessions signed in through an identity provider (F.1: provider disabled). */
  async revokeProviderSessions(trx: Trx, providerId: string, reason: SessionRevokeReason = 'idp_disabled'): Promise<number> {
    const now = this.infra.clock.now();
    const result = await inPlatformScope(trx, () =>
      trx
        .updateTable('platform.session')
        .set({ revoked_at: now, revoke_reason: reason })
        .where('identity_provider_id', '=', providerId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows);
  }

  /** Sets the session cookie (F.1); persistent sessions get `Max-Age` up to their absolute expiry. */
  setCookie(reply: FastifyReply, issued: IssuedSession): void {
    const maxAge = issued.row.persistent
      ? Math.max(0, Math.floor((issued.row.absolute_expires_at.getTime() - this.infra.clock.now().getTime()) / 1000))
      : undefined;
    reply.setCookie(this.cookieName, issued.cookieValue, {
      path: '/',
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      ...(maxAge !== undefined ? { maxAge } : {}),
    });
  }

  /** Clears the session cookie. */
  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(this.cookieName, { path: '/', httpOnly: true, secure: this.secureCookies, sameSite: 'lax' });
  }

  /** Called by the session resolver: the session found for this request. */
  remember(request: FastifyRequest, session: CurrentSession): void {
    this.current.set(request, session);
  }

  /** The session the resolver found for this request, or null (public routes, no cookie). */
  currentOf(request: FastifyRequest): CurrentSession | null {
    return this.current.get(request) ?? null;
  }

  /** The CSRF token of the request's session (for `Me.csrfToken`), or null. */
  csrfTokenOf(request: FastifyRequest): string | null {
    const session = this.currentOf(request);
    return session ? csrfTokenFor(session.cookieValue) : null;
  }

  /** `PrincipalSession` of a row (F.7). */
  principalSession(row: SessionRow): PrincipalSession {
    return {
      idHash: row.id_hash.toString('hex'),
      state: row.state,
      authMethod: row.auth_method,
      authOrgId: row.auth_org_id,
      authGrantId: row.auth_grant_id,
      identityProviderId: row.identity_provider_id,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      passwordAt: row.password_at,
      mfaAt: row.mfa_at,
    };
  }

  private async insert(
    trx: Trx,
    now: Date,
    values: Omit<SessionRow, 'id_hash' | 'csrf_token_hash' | 'created_at' | 'last_seen_at' | 'idle_expires_at' | 'revoked_at' | 'revoke_reason' | 'ip' | 'user_agent'>,
  ): Promise<IssuedSession> {
    const cookieValue = randomToken();
    const csrfToken = csrfTokenFor(cookieValue);
    const idle = new Date(Math.min(now.getTime() + this.timeouts(values.auth_method).idleMs, values.absolute_expires_at.getTime()));
    const context = currentRequestContext();
    const ip = context?.ip && isIP(context.ip) ? context.ip : null;
    const row = await inPlatformScope(trx, () =>
      trx
        .insertInto('platform.session')
        .values({
          ...values,
          id_hash: sha256(cookieValue),
          csrf_token_hash: sha256(csrfToken),
          created_at: now,
          last_seen_at: now,
          idle_expires_at: idle,
          ip,
          user_agent: cut(context?.userAgent, 1000),
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    return { cookieValue, csrfToken, row };
  }
}
