// Guest auditor sign-in (build plan F.14 steps 2 to 4, F.3, F.5, D-27):
//
// - `start`: the token of the access link (posted by the `/guest` page from the URL fragment, never sent in a URL)
//   is looked up by its SHA-256 in the grant's organisation; a valid, unused, unexpired, unrevoked grant marks
//   `link_used_at` (the link works once) and gets a one-time code transaction.
// - `login`: a returning guest names the grant address; when an active grant exists for it a new code is sent. The
//   answer and the cookie are the same either way.
// - A code transaction is a `platform.auth_transaction` of kind `guest_otp` (10 minutes, 5 attempts) bound to the
//   cookie `mscd_guest_tx`; only a MAC of the code is stored. The code is emailed to the grant address.
// - `verify`: the right code ends the transaction and creates a session pinned to the grant (`auth_method = 'guest'`,
//   `auth_grant_id`, `auth_org_id`) in `mfa_enrolment` on first use, else `mfa_pending`; the existing MFA routes
//   finish the sign-in with TOTP (F.5).
// - `resolve` is the `GuestOtpResolver` of the session resolver for `auth: 'guest_otp'` routes.
//
// Rate limits (F.3): per address 10 an hour on start and login (route definitions), per grant 5 an hour (here).
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { authGuestStartRoute, type GuestStartResponse, type LoginResponse, type RateLimitDef } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { Clock } from '../../../common/clock';
import { RateLimitedError, UnauthenticatedError } from '../../../common/problems';
import { AUDIT_WRITER, SYSTEM_USER_ID, type AuditWriter, type Principal, type TenantInfo, type Trx } from '../../../common/tokens';
import { MscdConfig } from '../../../config/mscd-config';
import { SecretBox } from '../../keys/secret-box';
import { RateLimitService } from '../../platform/rate-limit';
import { TenantResolver } from '../../tenancy/tenant-resolver';
import { TenantScope } from '../../tenancy/tenant-scope';
import { AccountMailer } from '../account-mailer';
import { MfaService } from '../mfa.service';
import { inPlatformScope } from '../platform-scope';
import { SessionService, type IssuedSession } from '../session.service';
import { principalUser, SignInResponder, type UserColumns } from '../sign-in-responder';
import { RANDOM_TOKEN, randomToken, sha256 } from '../tokens';
import {
  emailHint,
  GUEST_CODE_ATTEMPTS,
  GUEST_CODE_MAC_PURPOSE,
  GUEST_CODE_TTL_MS,
  GUEST_TX_COOKIE,
  GUEST_TX_COOKIE_PATH,
  guestCodeMacInput,
  newGuestCode,
  organisationOfLinkToken,
} from './guest-tokens';

/** F.3: 5 code requests per grant and hour (start and login count together). */
const PER_GRANT_LIMIT: RateLimitDef = authGuestStartRoute.rateLimits?.find((l) => l.key === 'grant') ?? { key: 'grant', max: 5, windowSeconds: 3600 };
const PER_GRANT_SCOPE = 'auth.guest.code';

const USER_COLUMNS = ['id', 'handle', 'email', 'display_name', 'job_title', 'kind', 'status', 'deleted_at'] as const;

interface GrantRow {
  id: string;
  email: string;
  user_id: string | null;
  link_used_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

interface GuestUserRow extends UserColumns {
  status: string;
  deleted_at: Date | null;
}

type VerifyOutcome =
  | { kind: 'ok'; issued: IssuedSession; user: GuestUserRow }
  | { kind: 'wrong' }
  | { kind: 'invalid' };

function linkInvalid(): UnauthenticatedError {
  return new UnauthenticatedError({ detail: 'This access link is not valid: it was used already, has expired or was revoked' });
}

function codeInvalid(): UnauthenticatedError {
  return new UnauthenticatedError({ detail: 'The code is not valid or has expired; ask for a new code' });
}

@Injectable()
export class GuestAccessService {
  private readonly logger = new Logger('GuestAccess');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    private readonly secrets: SecretBox,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly mailer: AccountMailer,
    private readonly responder: SignInResponder,
    @Optional() private readonly rateLimits?: RateLimitService,
  ) {}

  // -------------------------------------------------------------------------------------------------- the cookie

  private cookieOptions() {
    return { path: GUEST_TX_COOKIE_PATH, httpOnly: true, secure: this.config.profile.security.cookie_secure, sameSite: 'strict' as const };
  }

  private setBindingCookie(reply: FastifyReply, binding: string): void {
    reply.setCookie(GUEST_TX_COOKIE, binding, { ...this.cookieOptions(), maxAge: GUEST_CODE_TTL_MS / 1000 });
  }

  private clearBindingCookie(reply: FastifyReply): void {
    reply.clearCookie(GUEST_TX_COOKIE, this.cookieOptions());
  }

  private bindingOf(request: FastifyRequest): string | null {
    const value = request.cookies?.[GUEST_TX_COOKIE];
    return typeof value === 'string' && RANDOM_TOKEN.test(value) ? value : null;
  }

  // ---------------------------------------------------------------------------------------- POST /auth/guest/start

  async start(request: FastifyRequest, reply: FastifyReply, token: string): Promise<GuestStartResponse> {
    const orgId = organisationOfLinkToken(token);
    const org = orgId ? await this.tenants.resolveById(orgId) : null;
    if (!org || org.status !== 'active') throw linkInvalid();
    const tokenHash = sha256(token);
    const now = this.clock.now();

    // Find the grant first (no lock), so the per-grant limit is counted outside the transaction that changes it.
    const found = await this.scope.withTenant({ orgId: org.id, schema: org.schema, userId: SYSTEM_USER_ID }, (trx) =>
      trx.selectFrom('auditor_access_grant').select(['id']).where('token_hash', '=', tokenHash).executeTakeFirst(),
    );
    if (!found) throw linkInvalid();
    await this.countForGrant(request, found.id);

    const binding = randomToken();
    const sent = await this.scope.withTenant({ orgId: org.id, schema: org.schema, userId: SYSTEM_USER_ID }, async (trx) => {
      // Single use: only the first request that finds the link unused marks it (F.14 step 2).
      const grant = await trx
        .updateTable('auditor_access_grant')
        .set({ link_used_at: now, updated_at: now })
        .where('id', '=', found.id)
        .where('link_used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where('expires_at', '>', now)
        .returning(['id', 'email', 'user_id', 'link_used_at', 'expires_at', 'revoked_at', 'deleted_at', 'created_at'])
        .executeTakeFirst();
      if (!grant) return null;
      const user = await this.usableGuest(trx, org.id, grant);
      if (!user) return null;
      await this.issueCode(trx, org, grant, user, binding, 'link');
      return grant;
    });
    if (!sent) throw linkInvalid();
    this.setBindingCookie(reply, binding);
    return { status: 'code_sent', emailHint: emailHint(sent.email) };
  }

  // ---------------------------------------------------------------------------------------- POST /auth/guest/login

  async login(request: FastifyRequest, reply: FastifyReply, email: string): Promise<GuestStartResponse> {
    const address = email.trim();
    const binding = randomToken();
    try {
      const target = await this.activeGrantFor(address);
      if (target) {
        const limited = await this.overGrantLimit(request, target.grantId);
        if (!limited) await this.sendForGrant(target.org, target.grantId, binding);
        else this.logger.warn({ grantId: target.grantId }, 'Guest code request over the per-grant limit; no code sent');
      }
    } catch (error) {
      // The answer must not reveal whether a grant exists; a failure is logged and the answer stays the same.
      this.logger.error(`Guest code request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The cookie is set whether or not a transaction exists, so the answer looks the same either way (F.14 step 4).
    this.setBindingCookie(reply, binding);
    return { status: 'code_sent', emailHint: emailHint(address) };
  }

  /** The newest active grant (unrevoked, unexpired, guest account and membership active) of an address, if any. */
  private async activeGrantFor(email: string): Promise<{ org: TenantInfo; grantId: string } | null> {
    const now = this.clock.now();
    const candidates = await this.scope.withPlatform(
      (trx) =>
        trx
          .selectFrom('platform.app_user as u')
          .innerJoin('platform.org_membership as m', 'm.user_id', 'u.id')
          .select(['u.id as user_id', 'm.organization_id'])
          .where(sql<string>`lower(u.email)`, '=', email.toLowerCase())
          .where('u.kind', '=', 'guest')
          .where('u.status', '=', 'active')
          .where('u.deleted_at', 'is', null)
          .where('m.status', '=', 'active')
          .where('m.deleted_at', 'is', null)
          .execute(),
      { scope: 'auth' },
    );
    let best: { org: TenantInfo; grantId: string; createdAt: Date } | null = null;
    const byOrg = new Map<string, string[]>();
    for (const c of candidates) byOrg.set(c.organization_id, [...(byOrg.get(c.organization_id) ?? []), c.user_id]);
    for (const [orgId, userIds] of byOrg) {
      const org = await this.tenants.resolveById(orgId);
      if (!org || org.status !== 'active') continue;
      const grant = await this.scope.withTenant({ orgId: org.id, schema: org.schema, userId: SYSTEM_USER_ID }, (trx) =>
        trx
          .selectFrom('auditor_access_grant')
          .select(['id', 'created_at'])
          .where('user_id', 'in', userIds)
          .where('revoked_at', 'is', null)
          .where('deleted_at', 'is', null)
          .where('expires_at', '>', now)
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst(),
      );
      if (grant && (!best || grant.created_at.getTime() > best.createdAt.getTime())) best = { org, grantId: grant.id, createdAt: grant.created_at };
    }
    return best ? { org: best.org, grantId: best.grantId } : null;
  }

  private async sendForGrant(org: TenantInfo, grantId: string, binding: string): Promise<void> {
    const now = this.clock.now();
    await this.scope.withTenant({ orgId: org.id, schema: org.schema, userId: SYSTEM_USER_ID }, async (trx) => {
      const grant = await trx
        .selectFrom('auditor_access_grant')
        .select(['id', 'email', 'user_id', 'link_used_at', 'expires_at', 'revoked_at', 'deleted_at', 'created_at'])
        .where('id', '=', grantId)
        .where('revoked_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where('expires_at', '>', now)
        .forUpdate()
        .executeTakeFirst();
      if (!grant) return;
      const user = await this.usableGuest(trx, org.id, grant);
      if (!user) return;
      await this.issueCode(trx, org, grant, user, binding, 'returning');
    });
  }

  // ------------------------------------------------------------------------------------------ the code transaction

  /** Writes the code transaction (replacing older ones of the grant), audits and emails the code after commit. */
  private async issueCode(trx: Trx, org: TenantInfo, grant: GrantRow, user: GuestUserRow, binding: string, via: 'link' | 'returning'): Promise<void> {
    const now = this.clock.now();
    const code = newGuestCode();
    const id = randomUUID();
    const bindingHash = sha256(binding);
    await inPlatformScope(trx, async () => {
      await trx.deleteFrom('platform.auth_transaction').where('kind', '=', 'guest_otp').where('target_id', '=', grant.id).execute();
      await trx
        .insertInto('platform.auth_transaction')
        .values({
          id,
          kind: 'guest_otp',
          organization_id: org.id,
          user_id: user.id,
          target_id: grant.id,
          state_hash: bindingHash,
          browser_binding_hash: bindingHash,
          otp_hash: this.secrets.mac(GUEST_CODE_MAC_PURPOSE, guestCodeMacInput(id, code)),
          attempts: 0,
          expires_at: new Date(now.getTime() + GUEST_CODE_TTL_MS),
        })
        .execute();
    });
    await this.audit.record(trx, {
      action: 'auth.guest_code_sent',
      actor: { userId: user.id, kind: 'guest' },
      organizationId: org.id,
      entityType: 'auditor_access_grant',
      entityId: grant.id,
      after: { via, grantId: grant.id },
    });
    this.mailer.sendAfterCommit(trx, {
      to: { email: grant.email, userId: user.id },
      template: { name: 'guest_code', code, minutes: GUEST_CODE_TTL_MS / 60_000 },
    });
  }

  /** The guest account of a grant when it and its membership are active, else null. */
  private async usableGuest(trx: Trx, orgId: string, grant: Pick<GrantRow, 'user_id'>): Promise<GuestUserRow | null> {
    if (!grant.user_id) return null;
    const user = await trx
      .selectFrom('platform.app_user as u')
      .innerJoin('platform.org_membership as m', (join) => join.onRef('m.user_id', '=', 'u.id').on('m.organization_id', '=', orgId))
      .select(USER_COLUMNS.map((c) => `u.${c}` as const))
      .where('u.id', '=', grant.user_id)
      .where('u.kind', '=', 'guest')
      .where('u.status', '=', 'active')
      .where('u.deleted_at', 'is', null)
      .where('m.status', '=', 'active')
      .where('m.deleted_at', 'is', null)
      .executeTakeFirst();
    return (user as GuestUserRow | undefined) ?? null;
  }

  private async countForGrant(request: FastifyRequest, grantId: string): Promise<void> {
    if (!this.rateLimits) return;
    const { exceeded, retryAfter } = await this.rateLimits.hit(request, PER_GRANT_SCOPE, PER_GRANT_LIMIT, grantId);
    if (exceeded) throw new RateLimitedError(retryAfter);
  }

  private async overGrantLimit(request: FastifyRequest, grantId: string): Promise<boolean> {
    if (!this.rateLimits) return false;
    const { exceeded } = await this.rateLimits.hit(request, PER_GRANT_SCOPE, PER_GRANT_LIMIT, grantId);
    return exceeded;
  }

  // --------------------------------------------------------------------------------------- POST /auth/guest/verify

  async verify(request: FastifyRequest, reply: FastifyReply, principal: Principal, code: string): Promise<LoginResponse> {
    const transactionId = principal.guestTransactionId;
    const org = principal.org;
    if (!transactionId || !org) throw codeInvalid();
    const now = this.clock.now();
    const presented = this.sessions.readCookie(request);
    const outcome = await this.scope.withTenant(
      { orgId: org.id, schema: org.schema, userId: principal.user.id },
      async (trx): Promise<VerifyOutcome> => {
        const tx = await inPlatformScope(trx, () =>
          trx
            .selectFrom('platform.auth_transaction')
            .select(['id', 'user_id', 'target_id', 'organization_id', 'otp_hash', 'attempts', 'expires_at'])
            .where('id', '=', transactionId)
            .where('kind', '=', 'guest_otp')
            .forUpdate()
            .executeTakeFirst(),
        );
        if (!tx || !tx.otp_hash || !tx.target_id || !tx.user_id || tx.organization_id !== org.id) return { kind: 'invalid' };
        if (tx.expires_at.getTime() <= now.getTime() || tx.attempts >= GUEST_CODE_ATTEMPTS) {
          await this.dropTransaction(trx, tx.id);
          return { kind: 'invalid' };
        }
        if (!this.secrets.verifyMac(GUEST_CODE_MAC_PURPOSE, guestCodeMacInput(tx.id, code), tx.otp_hash)) {
          const attempts = tx.attempts + 1;
          if (attempts >= GUEST_CODE_ATTEMPTS) await this.dropTransaction(trx, tx.id);
          else await inPlatformScope(trx, () => trx.updateTable('platform.auth_transaction').set({ attempts }).where('id', '=', tx.id).execute());
          await this.audit.record(trx, {
            action: 'auth.login_failed',
            actor: { userId: tx.user_id, kind: 'guest' },
            organizationId: org.id,
            entityType: 'user',
            entityId: tx.user_id,
            after: { method: 'guest', reason: 'wrong_code', attempts, grantId: tx.target_id },
          });
          return { kind: 'wrong' };
        }
        // The right code: the transaction is used up whatever follows.
        await this.dropTransaction(trx, tx.id);
        const grant = await trx
          .selectFrom('auditor_access_grant')
          .select(['id', 'email', 'user_id', 'link_used_at', 'expires_at', 'revoked_at', 'deleted_at', 'created_at'])
          .where('id', '=', tx.target_id)
          .forUpdate()
          .executeTakeFirst();
        if (!grant || grant.revoked_at || grant.deleted_at || grant.expires_at.getTime() <= now.getTime() || grant.user_id !== tx.user_id) {
          return { kind: 'invalid' };
        }
        const user = await this.usableGuest(trx, org.id, grant);
        if (!user) return { kind: 'invalid' };
        await trx.updateTable('auditor_access_grant').set({ last_used_at: now, updated_at: now }).where('id', '=', grant.id).execute();
        const state = (await inPlatformScope(trx, () => this.mfa.hasConfirmedFactor(trx, user.id))) ? 'mfa_pending' : 'mfa_enrolment';
        const issued = await inPlatformScope(trx, async () => {
          if (presented) await this.sessions.revoke(trx, sha256(presented), 'signed_in_again');
          const created = await this.sessions.create(trx, {
            userId: user.id,
            organizationId: org.id,
            authOrgId: org.id,
            state,
            authMethod: 'guest',
            authGrantId: grant.id,
          });
          return this.capAtGrantExpiry(trx, created, grant.expires_at);
        });
        await this.audit.record(trx, {
          action: 'auth.guest_login',
          actor: { userId: user.id, kind: 'guest' },
          organizationId: org.id,
          entityType: 'user',
          entityId: user.id,
          entityCode: user.handle,
          after: { grantId: grant.id, next: state },
        });
        return { kind: 'ok', issued, user };
      },
    );
    if (outcome.kind !== 'ok') {
      if (outcome.kind === 'invalid') this.clearBindingCookie(reply);
      throw codeInvalid();
    }
    this.clearBindingCookie(reply);
    return this.responder.respond(reply, outcome.issued, principalUser(outcome.user));
  }

  /**
   * A guest session never outlives its grant (F.14 step 5): its absolute and idle expiry are cut to the grant's
   * `expires_at`. The session resolver then refuses it once the grant expires, and `cleanup.expired` revokes it,
   * without waiting for the grant list or grant route to close the grant. Rotations keep the absolute expiry.
   */
  private async capAtGrantExpiry(trx: Trx, issued: IssuedSession, grantExpiresAt: Date): Promise<IssuedSession> {
    const { row } = issued;
    if (grantExpiresAt.getTime() >= row.absolute_expires_at.getTime()) return issued;
    const idle = new Date(Math.min(row.idle_expires_at.getTime(), grantExpiresAt.getTime()));
    await trx
      .updateTable('platform.session')
      .set({ absolute_expires_at: grantExpiresAt, idle_expires_at: idle })
      .where('id_hash', '=', row.id_hash)
      .execute();
    return { ...issued, row: { ...row, absolute_expires_at: grantExpiresAt, idle_expires_at: idle } };
  }

  private async dropTransaction(trx: Trx, id: string): Promise<void> {
    await inPlatformScope(trx, () => trx.deleteFrom('platform.auth_transaction').where('id', '=', id).execute());
  }

  // ------------------------------------------------------------------------------------- GuestOtpResolver (F.14)

  /** The guest of the request's binding cookie, or null (the guard then answers 401). */
  async resolve(request: FastifyRequest): Promise<Principal | null> {
    const binding = this.bindingOf(request);
    if (!binding) return null;
    const now = this.clock.now();
    const found = await this.scope.withPlatform(
      async (trx) => {
        const tx = await trx
          .selectFrom('platform.auth_transaction')
          .select(['id', 'user_id', 'organization_id', 'browser_binding_hash', 'expires_at', 'attempts'])
          .where('state_hash', '=', sha256(binding))
          .where('kind', '=', 'guest_otp')
          .executeTakeFirst();
        if (!tx || !tx.user_id || !tx.organization_id) return null;
        if (tx.expires_at.getTime() <= now.getTime() || tx.attempts >= GUEST_CODE_ATTEMPTS) return null;
        const user = await trx
          .selectFrom('platform.app_user')
          .select(USER_COLUMNS)
          .where('id', '=', tx.user_id)
          .where('kind', '=', 'guest')
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        return user ? { tx, user } : null;
      },
      { scope: 'auth' },
    );
    if (!found || !found.tx.organization_id) return null;
    const org = await this.tenants.resolveById(found.tx.organization_id);
    if (!org || org.status !== 'active') return null;
    return { user: principalUser(found.user), org, session: null, guestTransactionId: found.tx.id };
  }
}
