// OIDC sign-in, invitation redemption through a provider, JIT provisioning and identity linking (build plan F.8,
// F.5, D-25, D-26). The flow is the authorisation code grant with PKCE (S256), `state` and `nonce`:
//
// 1. `start` (and `startLink` for `POST /me/identities/{slug}/link`) writes an `auth_transaction` that holds only
//    hashes of the state and of a browser binding value, the nonce, the PKCE verifier sealed with `platform.key`
//    (`pkce:<transaction id>`), the relative return path and, for an invitation, its id. The binding value goes to
//    the browser in the cookie `mscd_auth_tx` (HttpOnly, SameSite=Lax, 10 minutes).
// 2. `callback` deletes the transaction by the state hash (single use), checks the binding cookie and the expiry,
//    and lets `openid-client` exchange the code (it validates issuer, audience, expiry, signature, state, nonce and
//    the PKCE verifier).
// 3. The subject is `sub`, or `<tid>:<oid>` for Entra ID providers. Email counts only when `email_verified` is true.
// 4. The account is found by (provider, subject) only, never by email: an existing link, the user of a link
//    transaction, an invitation of the provider's organisation, or a JIT account under verified domains. Anything
//    else is `no_account`.
// 5. MFA from the `amr` claim, else the local TOTP step or `mfa_required_by_policy`; then a session pinned to the
//    provider's organisation (D-26).
//
// Every failure redirects to `/login?error=<code>` and changes nothing but the consumed transaction.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { IdentityLinkStart, LoginErrorCode, SsoStartQuery } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import * as oidc from 'openid-client';
import { MscdConfig } from '../../../config/mscd-config';
import { Clock } from '../../../common/clock';
import { NotFoundError, ProblemError, UnauthenticatedError } from '../../../common/problems';
import {
  AUDIT_WRITER,
  LICENCE_GATE,
  SESSION_RESOLVER,
  type AuditWriter,
  type LicenceGate,
  type SessionResolver,
  type Trx,
} from '../../../common/tokens';
import { SecretBox } from '../../keys/secret-box';
import { TenantScope } from '../../tenancy/tenant-scope';
import { AccountMailer } from '../account-mailer';
import { AuthService } from '../auth.service';
import { handleBase } from '../invitation.service';
import { hasRecentProof, MfaService } from '../mfa.service';
import { SessionService, type CurrentSession, type IssuedSession } from '../session.service';
import { randomToken, sameBytes, sha256 } from '../tokens';
import { OidcDiscovery } from './discovery';
import { IdentityLinkRegistry, type IdentityLinkStarter, type LinkableProvider } from './identity-link.registry';
import {
  amrOf,
  decideSsoMfa,
  emailDomain,
  loginErrorPath,
  safeReturnPath,
  SsoFailure,
  subjectOf,
  verifiedEmailOf,
  type IdTokenClaims,
} from './oidc-rules';
import { providerBySlug, providerUsable, type ProviderRow } from './provider-lookup';

/** Cookie of the browser binding of an OIDC transaction (F.8 step 1). */
export const AUTH_TX_COOKIE = 'mscd_auth_tx';
/** The cookie is sent only to the OIDC routes (the callbacks). */
export const AUTH_TX_COOKIE_PATH = '/api/v1/auth/oidc/';
/** Lifetime of an OIDC transaction and its binding cookie (F.8 step 1). */
export const AUTH_TX_TTL_MS = 10 * 60_000;

/** Path of the callback of a provider; the redirect URI is `<http.public_url><path>`. */
export function oidcCallbackPath(slug: string): string {
  return `/api/v1/auth/oidc/${encodeURIComponent(slug)}/callback`;
}

/** Second-factor pages of the web that take over the CSRF token of the new session in the fragment (WP-38). */
const MFA_PAGE = '/login/mfa';
const ENROL_PAGE = '/login/enrol';

const HANDLE = /^[a-z][a-z0-9._-]{1,39}$/;

/** What the controller sends: a redirect, with the session to set when one was created. */
export interface OidcRedirect {
  location: string;
  session?: IssuedSession;
}

type OidcTransactionKind = 'oidc_login' | 'oidc_link';

interface TransactionRow {
  id: string;
  kind: string;
  identity_provider_id: string | null;
  organization_id: string | null;
  user_id: string | null;
  target_id: string | null;
  browser_binding_hash: Buffer;
  nonce: string | null;
  code_verifier_sealed: string | null;
  return_to: string | null;
  expires_at: Date;
}

interface InvitationRow {
  id: string;
  organization_id: string;
  user_id: string;
  email: string;
  used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
}

interface AccountRow {
  id: string;
  handle: string;
  email: string;
  kind: 'person' | 'system' | 'guest';
  status: 'active' | 'invited' | 'disabled';
  mfa_required: boolean;
  deleted_at: Date | null;
}

/** What the token says about the person, after the F.8 step 3 rules. */
interface TokenIdentity {
  subject: string;
  email: string | null;
  amr: string[];
  displayName: string | null;
}

const ACCOUNT_COLUMNS = ['id', 'handle', 'email', 'kind', 'status', 'mfa_required', 'deleted_at'] as const;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown })?.code === '23505';
}

/** A display name from the usual OIDC claims (`name`, else given and family name), at most 150 characters. */
function displayNameOf(claims: IdTokenClaims): string | null {
  const pick = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const name = pick(claims.name) || [pick(claims.given_name), pick(claims.family_name)].filter(Boolean).join(' ');
  return name ? name.slice(0, 150) : null;
}

@Injectable()
export class OidcSignInService implements OnModuleInit {
  private readonly logger = new Logger('OidcSignIn');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly secrets: SecretBox,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
    @Inject(SESSION_RESOLVER) private readonly sessionResolver: SessionResolver,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly mailer: AccountMailer,
    private readonly discovery: OidcDiscovery,
    private readonly links: IdentityLinkRegistry,
  ) {}

  onModuleInit(): void {
    const starter: IdentityLinkStarter = { start: (current, provider, reply) => this.startOidcLink(current, provider, reply) };
    this.links.register('oidc', starter);
  }

  /** The redirect URI registered with the identity provider: `<http.public_url>/api/v1/auth/oidc/<slug>/callback`. */
  redirectUri(slug: string): string {
    return `${this.config.profile.http.public_url.replace(/\/+$/, '')}${oidcCallbackPath(slug)}`;
  }

  /** Sets the binding cookie of a new transaction (F.8 step 1). */
  setBindingCookie(reply: FastifyReply, binding: string): void {
    reply.setCookie(AUTH_TX_COOKIE, binding, {
      path: AUTH_TX_COOKIE_PATH,
      httpOnly: true,
      secure: this.config.profile.security.cookie_secure,
      sameSite: 'lax',
      maxAge: AUTH_TX_TTL_MS / 1000,
    });
  }

  /** Clears the binding cookie (every callback, whatever its outcome). */
  clearBindingCookie(reply: FastifyReply): void {
    reply.clearCookie(AUTH_TX_COOKIE, { path: AUTH_TX_COOKIE_PATH, httpOnly: true, secure: this.config.profile.security.cookie_secure, sameSite: 'lax' });
  }

  // ------------------------------------------------------------------------------------------------- start (step 1)

  /**
   * `GET /auth/oidc/{slug}/start`: 404 for an unknown, disabled or non-OIDC provider. An invitation token that is not
   * a valid invitation of the provider's organisation, or a provider whose discovery fails, redirects to the login
   * page with `invitation_invalid` or `idp_error`; otherwise the browser goes to the provider.
   */
  async start(reply: FastifyReply, slug: string, query: SsoStartQuery): Promise<OidcRedirect> {
    const now = this.clock.now();
    const prepared = await this.scope.withPlatform(
      async (trx) => {
        const provider = await providerBySlug(trx, slug);
        if (!provider || !providerUsable(this.config.profile, provider, 'oidc')) return null;
        let invitationId: string | null = null;
        if (query.invitation) {
          const invitation = await this.invitationByToken(trx, query.invitation);
          if (!invitation || !this.invitationUsable(invitation, provider.organization_id, now)) return { provider, invitationValid: false as const };
          invitationId = invitation.id;
        }
        return { provider, invitationValid: true as const, invitationId };
      },
      { scope: 'auth' },
    );
    if (!prepared) throw new NotFoundError('Unknown identity provider');
    if (!prepared.invitationValid) return { location: loginErrorPath('invitation_invalid') };
    try {
      const redirectUrl = await this.openTransaction(reply, prepared.provider, {
        kind: 'oidc_login',
        userId: null,
        invitationId: prepared.invitationId,
        returnTo: safeReturnPath(query.returnTo),
      });
      return { location: redirectUrl };
    } catch (error) {
      this.logger.warn(`OIDC sign-in with ${slug} could not start: ${error instanceof Error ? error.message : String(error)}`);
      return { location: loginErrorPath('idp_error') };
    }
  }

  // ------------------------------------------------------------------------------------------- identity link (F.8)

  /**
   * `POST /me/identities/{slug}/link` (D.3, D-25 path b): the session user links a provider identity. The provider
   * must be enabled and belong to an organisation where the user is an active member (404 otherwise), and the session
   * must have verified the password or a TOTP code in the last 5 minutes (401 `auth.proof_required`). The provider's
   * kind decides who starts the flow (`IdentityLinkRegistry`).
   */
  async startLink(current: CurrentSession, slug: string, reply: FastifyReply): Promise<IdentityLinkStart> {
    const userId = current.row.user_id;
    const provider = await this.scope.withPlatform(
      async (trx) => {
        const row = await providerBySlug(trx, slug);
        if (!row || !providerUsable(this.config.profile, row)) return null;
        if (current.principal.user.kind !== 'person') return null;
        return (await this.activeMembership(trx, row.organization_id, userId)) ? row : null;
      },
      { scope: 'auth', userId },
    );
    const starter = provider ? this.links.starterFor(provider.kind) : null;
    if (!provider || !starter) throw new NotFoundError('Unknown identity provider');
    if (!hasRecentProof(current.row, this.clock.now())) {
      throw new UnauthenticatedError({
        messageKey: 'auth.proof_required',
        detail: 'Confirm your password or authenticator code first; linking needs a proof from the last 5 minutes',
      });
    }
    return starter.start(current, { id: provider.id, slug: provider.slug, kind: provider.kind, organizationId: provider.organization_id }, reply);
  }

  /** The OIDC starter of `IdentityLinkRegistry`: an `oidc_link` transaction for the session user. */
  async startOidcLink(current: CurrentSession, provider: LinkableProvider, reply: FastifyReply): Promise<IdentityLinkStart> {
    const row = await this.scope.withPlatform((trx) => providerBySlug(trx, provider.slug), { scope: 'auth', userId: current.row.user_id });
    if (!row || row.id !== provider.id || !providerUsable(this.config.profile, row, 'oidc')) throw new NotFoundError('Unknown identity provider');
    let redirectUrl: string;
    try {
      redirectUrl = await this.openTransaction(reply, row, { kind: 'oidc_link', userId: current.row.user_id, invitationId: null, returnTo: '/' });
    } catch (error) {
      this.logger.warn(`Identity link with ${row.slug} could not start: ${error instanceof Error ? error.message : String(error)}`);
      throw new ProblemError('dependency-unavailable', { detail: 'The identity provider cannot be reached; try again later' });
    }
    return { redirectUrl };
  }

  // -------------------------------------------------------------------------------------------- callback (steps 2-6)

  /**
   * `GET /auth/oidc/{slug}/callback`: returns where to redirect. Never throws for a failed sign-in: every failure is
   * a redirect to `/login?error=<code>`.
   */
  async callback(request: FastifyRequest, slug: string, query: { state: string; error?: string }): Promise<OidcRedirect> {
    const binding = request.cookies?.[AUTH_TX_COOKIE];
    const transaction = await this.consumeTransaction(query.state);
    let provider: ProviderRow | null = null;
    try {
      if (!transaction) throw new SsoFailure('expired', 'transaction_not_found');
      provider = await this.scope.withPlatform((trx) => providerBySlug(trx, slug).then((p) => p ?? null), { scope: 'auth' });
      return await this.completeCallback(request, transaction, provider, binding, query);
    } catch (error) {
      const failure = error instanceof SsoFailure ? error : this.unexpected(error);
      await this.recordFailure(failure, transaction, provider);
      return { location: loginErrorPath(failure.code) };
    }
  }

  private async completeCallback(
    request: FastifyRequest,
    transaction: TransactionRow,
    provider: ProviderRow | null,
    binding: string | undefined,
    query: { state: string; error?: string },
  ): Promise<OidcRedirect> {
    const now = this.clock.now();
    if (transaction.expires_at.getTime() <= now.getTime()) throw new SsoFailure('expired', 'transaction_expired');
    if (typeof binding !== 'string' || binding === '' || !sameBytes(sha256(binding), transaction.browser_binding_hash)) {
      throw new SsoFailure('expired', 'binding_mismatch');
    }
    if (!provider || provider.id !== transaction.identity_provider_id) throw new SsoFailure('expired', 'provider_mismatch');
    if (!providerUsable(this.config.profile, provider, 'oidc')) throw new SsoFailure('idp_error', 'provider_disabled');
    const kind = transaction.kind as OidcTransactionKind;
    if (kind === 'oidc_link') {
      // F.2: a link callback changes nothing unless this browser is signed in as the transaction's user.
      const principal = await this.sessionResolver.resolve(request, 'session').catch(() => null);
      if (!principal?.session || principal.session.state !== 'active' || principal.user.id !== transaction.user_id) {
        throw new SsoFailure('expired', 'link_session_mismatch');
      }
    }
    if (query.error) throw new SsoFailure('idp_error', `provider_error:${query.error.slice(0, 60)}`);

    const identity = await this.exchange(request, provider, transaction, query.state);
    if (kind === 'oidc_link') return this.completeLink(transaction, provider, identity);
    return this.completeLogin(request, transaction, provider, identity);
  }

  /** F.8 step 2 and 3: the code exchange and the token rules. */
  private async exchange(request: FastifyRequest, provider: ProviderRow, transaction: TransactionRow, state: string): Promise<TokenIdentity> {
    if (!transaction.nonce || !transaction.code_verifier_sealed) throw new SsoFailure('expired', 'transaction_incomplete');
    const verifier = await this.secrets.openText(transaction.code_verifier_sealed, { purpose: 'pkce', transactionId: transaction.id });
    let claims: IdTokenClaims | undefined;
    try {
      const configuration = await this.discovery.configurationFor(provider);
      const current = new URL(this.redirectUri(provider.slug));
      const queryAt = request.url.indexOf('?');
      current.search = queryAt >= 0 ? request.url.slice(queryAt) : '';
      const tokens = await oidc.authorizationCodeGrant(configuration, current, {
        expectedState: state,
        expectedNonce: transaction.nonce,
        pkceCodeVerifier: verifier,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      throw new SsoFailure('idp_error', `token_exchange:${typeof code === 'string' ? code : error instanceof Error ? error.name : 'error'}`);
    }
    if (!claims) throw new SsoFailure('idp_error', 'id_token_missing');
    return { subject: subjectOf(claims, provider), email: verifiedEmailOf(claims), amr: amrOf(claims), displayName: displayNameOf(claims) };
  }

  /** F.8 steps 4 to 6 for a sign-in transaction. */
  private async completeLogin(request: FastifyRequest, transaction: TransactionRow, provider: ProviderRow, token: TokenIdentity): Promise<OidcRedirect> {
    const now = this.clock.now();
    const orgId = provider.organization_id;
    const presented = this.sessions.readCookie(request);
    const issued = await this.scope.withPlatform(
      async (trx) => {
        const account = await this.resolveAccount(trx, transaction, provider, token, now);
        if (account.kind !== 'person' || account.status !== 'active' || account.deleted_at !== null) {
          throw new SsoFailure('no_account', `account_${account.deleted_at ? 'deleted' : account.kind === 'person' ? account.status : account.kind}`);
        }
        if (!(await this.activeMembership(trx, orgId, account.id))) throw new SsoFailure('no_account', 'not_a_member');

        const decision = decideSsoMfa(token.amr, provider);
        if (decision.kind === 'reject') throw new SsoFailure('mfa_required_by_policy', 'mfa_claim_missing');
        const state =
          decision.kind === 'idp' || !this.auth.secondFactorRequired(account)
            ? 'active'
            : (await this.mfa.hasConfirmedFactor(trx, account.id))
              ? 'mfa_pending'
              : 'mfa_enrolment';
        if (presented) await this.sessions.revoke(trx, sha256(presented), 'signed_in_again');
        const session = await this.sessions.create(trx, {
          userId: account.id,
          organizationId: orgId,
          authOrgId: orgId,
          state,
          authMethod: 'oidc',
          identityProviderId: provider.id,
          amr: token.amr,
        });
        await trx
          .updateTable('platform.user_identity')
          .set({ last_login_at: now })
          .where('identity_provider_id', '=', provider.id)
          .where('subject', '=', token.subject)
          .execute();
        if (state === 'active') {
          await this.auth.recordLogin(trx, account.id, orgId, now, {
            method: 'oidc',
            identityProviderId: provider.id,
            provider: provider.slug,
            subject: token.subject,
            secondFactor: decision.kind === 'idp' ? 'idp_mfa' : 'none',
            amr: token.amr,
          });
        }
        return session;
      },
      { scope: 'auth', orgId },
    );
    const state = issued.row.state;
    if (state === 'mfa_pending') return { location: `${MFA_PAGE}#csrf=${issued.csrfToken}`, session: issued };
    if (state === 'mfa_enrolment') return { location: `${ENROL_PAGE}#csrf=${issued.csrfToken}`, session: issued };
    return { location: safeReturnPath(transaction.return_to), session: issued };
  }

  /**
   * F.8 step 4, first match wins: an existing link of (provider, subject); an invitation of the provider's
   * organisation; JIT under verified domains. Links of invitations and JIT are written here. Never by email.
   */
  private async resolveAccount(trx: Trx, transaction: TransactionRow, provider: ProviderRow, token: TokenIdentity, now: Date): Promise<AccountRow> {
    const linked = await trx
      .selectFrom('platform.user_identity')
      .select('user_id')
      .where('identity_provider_id', '=', provider.id)
      .where('subject', '=', token.subject)
      .forUpdate()
      .executeTakeFirst();
    if (linked) {
      const account = await this.account(trx, linked.user_id);
      if (!account) throw new SsoFailure('no_account', 'account_missing');
      // The invitation of a pre-registered subject is still redeemed (its membership becomes active), but only by the
      // invitation's own user.
      if (transaction.target_id) {
        const invitation = await this.invitationById(trx, transaction.target_id);
        if (!invitation || !this.invitationUsable(invitation, provider.organization_id, now) || invitation.user_id !== account.id) {
          throw new SsoFailure('invitation_invalid', 'invitation_other_user');
        }
        return this.redeemInvitation(trx, invitation, account, provider, token, now, { linkIdentity: false });
      }
      return account;
    }

    if (transaction.target_id) {
      const invitation = await this.invitationById(trx, transaction.target_id);
      if (!invitation || !this.invitationUsable(invitation, provider.organization_id, now)) throw new SsoFailure('invitation_invalid', 'invitation_unusable');
      if (token.email !== null && token.email !== invitation.email.trim().toLowerCase()) throw new SsoFailure('invitation_invalid', 'invitation_email_mismatch');
      const account = await this.account(trx, invitation.user_id);
      if (!account || account.kind !== 'person' || account.status === 'disabled' || account.deleted_at !== null) {
        throw new SsoFailure('invitation_invalid', 'invitation_account_unusable');
      }
      return this.redeemInvitation(trx, invitation, account, provider, token, now, { linkIdentity: true });
    }

    if (provider.jit_provisioning) return this.provisionJit(trx, provider, token, now);
    throw new SsoFailure('no_account', token.email ? 'no_link' : 'no_link_unverified_email');
  }

  /**
   * F.8 step 4 invitation path: links the subject (unless it is linked already), activates the membership (after the
   * licence user check, D-15) and the account, and marks the invitation used.
   */
  private async redeemInvitation(
    trx: Trx,
    invitation: InvitationRow,
    account: AccountRow,
    provider: ProviderRow,
    token: TokenIdentity,
    now: Date,
    options: { linkIdentity: boolean },
  ): Promise<AccountRow> {
    const membership = await trx
      .selectFrom('platform.org_membership')
      .select(['status', 'deleted_at'])
      .where('organization_id', '=', invitation.organization_id)
      .where('user_id', '=', account.id)
      .forUpdate()
      .executeTakeFirst();
    if (!membership || membership.deleted_at !== null || membership.status === 'disabled') throw new SsoFailure('invitation_invalid', 'invitation_membership_unusable');
    if (account.status === 'disabled') throw new SsoFailure('invitation_invalid', 'invitation_account_unusable');
    if (options.linkIdentity) await this.insertIdentity(trx, provider, token, account.id, 'invitation', null, now);
    if (membership.status !== 'active') {
      await this.licence.assertCanAddUser(trx, invitation.organization_id);
      await trx
        .updateTable('platform.org_membership')
        .set({ status: 'active', accepted_at: now })
        .where('organization_id', '=', invitation.organization_id)
        .where('user_id', '=', account.id)
        .execute();
    }
    let status = account.status;
    if (status === 'invited') {
      await trx.updateTable('platform.app_user').set({ status: 'active' }).where('id', '=', account.id).execute();
      status = 'active';
    }
    await trx.updateTable('platform.invitation').set({ used_at: now }).where('id', '=', invitation.id).execute();
    const actor = { userId: account.id, kind: 'user' as const };
    if (options.linkIdentity) {
      await this.audit.record(trx, {
        action: 'identity.linked',
        actor,
        organizationId: provider.organization_id,
        entityType: 'user',
        entityId: account.id,
        entityCode: account.handle,
        after: { provider: provider.slug, identityProviderId: provider.id, subject: token.subject, linkMethod: 'invitation', invitationId: invitation.id },
      });
    }
    await this.audit.record(trx, {
      action: 'membership.updated',
      actor,
      organizationId: invitation.organization_id,
      entityType: 'user',
      entityId: account.id,
      entityCode: account.handle,
      before: { status: membership.status },
      after: { status: 'active', via: 'invitation_sso', invitationId: invitation.id, provider: provider.slug },
    });
    return { ...account, status };
  }

  /**
   * F.8 step 4 JIT: the provider allows it, every allowed domain is verified for the provider's organisation, the
   * token's verified email is under one of them and no non-guest account has that email. A new active account and an
   * active membership without roles are created after the licence user check (D-15).
   */
  private async provisionJit(trx: Trx, provider: ProviderRow, token: TokenIdentity, now: Date): Promise<AccountRow> {
    if (!token.email) throw new SsoFailure('no_account', 'jit_email_unverified');
    const allowed = [...new Set(provider.allowed_email_domains.map((d) => d.toLowerCase()))];
    if (allowed.length === 0) throw new SsoFailure('no_account', 'jit_no_domains');
    const verified = await trx
      .selectFrom('platform.verified_domain')
      .select('domain')
      .where('organization_id', '=', provider.organization_id)
      .where('domain', 'in', allowed)
      .execute();
    if (verified.length !== allowed.length) throw new SsoFailure('no_account', 'jit_domain_unverified');
    if (!allowed.includes(emailDomain(token.email))) throw new SsoFailure('no_account', 'jit_domain_not_allowed');
    const existing = await trx
      .selectFrom('platform.app_user')
      .select('id')
      .where(sql<string>`lower(email)`, '=', token.email)
      .where('kind', '<>', 'guest')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    // An account with this email exists: it must be linked through an invitation or from a signed-in session (D-25).
    if (existing) throw new SsoFailure('no_account', 'jit_email_taken');

    try {
      await this.licence.assertCanAddUser(trx, provider.organization_id);
    } catch (error) {
      if (error instanceof ProblemError && error.slug === 'business-rule') throw new SsoFailure('no_account', 'jit_licence_user_limit');
      throw error;
    }
    const handle = await this.uniqueHandle(trx, token.email);
    const user = await trx
      .insertInto('platform.app_user')
      .values({
        handle,
        email: token.email,
        display_name: token.displayName ?? (token.email.split('@')[0] ?? handle),
        kind: 'person',
        status: 'active',
        mfa_required: true,
      })
      .returning([...ACCOUNT_COLUMNS])
      .executeTakeFirstOrThrow();
    const hasOther = await trx.selectFrom('platform.org_membership').select('user_id').where('user_id', '=', user.id).executeTakeFirst();
    await trx
      .insertInto('platform.org_membership')
      .values({ organization_id: provider.organization_id, user_id: user.id, admin_roles: [], status: 'active', is_default: !hasOther, accepted_at: now })
      .execute();
    await this.insertIdentity(trx, provider, token, user.id, 'jit', null, now);
    const actor = { userId: user.id, kind: 'user' as const };
    await this.audit.record(trx, {
      action: 'user.created',
      actor,
      organizationId: provider.organization_id,
      entityType: 'user',
      entityId: user.id,
      entityCode: user.handle,
      after: { handle: user.handle, email: user.email, status: 'active', via: 'jit', provider: provider.slug, membership: 'active' },
    });
    await this.audit.record(trx, {
      action: 'identity.linked',
      actor,
      organizationId: provider.organization_id,
      entityType: 'user',
      entityId: user.id,
      entityCode: user.handle,
      after: { provider: provider.slug, identityProviderId: provider.id, subject: token.subject, linkMethod: 'jit' },
    });
    return user;
  }

  /**
   * F.8 step 4 link path: links the subject to the signed-in transaction user. An existing link of the same user is
   * kept as it is; a subject linked to another account is refused.
   */
  private async completeLink(transaction: TransactionRow, provider: ProviderRow, token: TokenIdentity): Promise<OidcRedirect> {
    const now = this.clock.now();
    const userId = transaction.user_id;
    if (!userId) throw new SsoFailure('expired', 'transaction_incomplete');
    await this.scope.withPlatform(
      async (trx) => {
        const account = await this.account(trx, userId);
        if (!account || account.kind !== 'person' || account.status !== 'active' || account.deleted_at !== null) throw new SsoFailure('expired', 'link_account_unusable');
        if (!(await this.activeMembership(trx, provider.organization_id, userId))) throw new SsoFailure('expired', 'link_not_a_member');
        const linked = await trx
          .selectFrom('platform.user_identity')
          .select('user_id')
          .where('identity_provider_id', '=', provider.id)
          .where('subject', '=', token.subject)
          .forUpdate()
          .executeTakeFirst();
        if (linked) {
          if (linked.user_id !== userId) throw new SsoFailure('idp_error', 'subject_linked_to_another_account');
          return;
        }
        await this.insertIdentity(trx, provider, token, userId, 'session', userId, now);
        await this.audit.record(trx, {
          action: 'identity.linked',
          actor: { userId, kind: 'user' },
          organizationId: provider.organization_id,
          entityType: 'user',
          entityId: userId,
          entityCode: account.handle,
          after: { provider: provider.slug, identityProviderId: provider.id, subject: token.subject, linkMethod: 'session' },
        });
        this.mailer.sendAfterCommit(trx, {
          to: { email: account.email, userId },
          template: { name: 'identity_linked', link: this.mailer.appLink('/'), provider: provider.display_name },
        });
      },
      { scope: 'auth', userId, orgId: provider.organization_id },
    );
    return { location: safeReturnPath(transaction.return_to) };
  }

  // ------------------------------------------------------------------------------------------------------- helpers

  /** Writes a transaction (F.8 step 1), sets the binding cookie and returns the authorisation URL. */
  private async openTransaction(
    reply: FastifyReply,
    provider: ProviderRow,
    input: { kind: OidcTransactionKind; userId: string | null; invitationId: string | null; returnTo: string },
  ): Promise<string> {
    const configuration = await this.discovery.configurationFor(provider);
    const now = this.clock.now();
    const id = randomUUID();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const binding = randomToken();
    const sealedVerifier = await this.secrets.seal(verifier, { purpose: 'pkce', transactionId: id });
    await this.scope.withPlatform(
      (trx) =>
        trx
          .insertInto('platform.auth_transaction')
          .values({
            id,
            kind: input.kind,
            identity_provider_id: provider.id,
            organization_id: provider.organization_id,
            user_id: input.userId,
            target_id: input.invitationId,
            state_hash: sha256(state),
            browser_binding_hash: sha256(binding),
            nonce,
            code_verifier_sealed: sealedVerifier,
            return_to: input.returnTo,
            created_at: now,
            expires_at: new Date(now.getTime() + AUTH_TX_TTL_MS),
          })
          .execute(),
      { scope: 'auth', userId: input.userId },
    );
    const url = oidc.buildAuthorizationUrl(configuration, {
      response_type: 'code',
      redirect_uri: this.redirectUri(provider.slug),
      scope: provider.oidc_scopes,
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      // A link or an invitation binds the identity to an account for good: the person signs in at the provider now,
      // so an earlier provider session in this browser (someone else's, on a shared computer) is never linked.
      ...(input.kind === 'oidc_link' || input.invitationId ? { prompt: 'login' } : {}),
    });
    this.setBindingCookie(reply, binding);
    return url.href;
  }

  /** F.8 step 2: deletes the transaction of a state (single use) and returns it, or null. */
  private async consumeTransaction(state: string): Promise<TransactionRow | null> {
    const row = await this.scope.withPlatform(
      (trx) =>
        trx
          .deleteFrom('platform.auth_transaction')
          .where('state_hash', '=', sha256(state))
          .where('kind', 'in', ['oidc_login', 'oidc_link'])
          .returning([
            'id',
            'kind',
            'identity_provider_id',
            'organization_id',
            'user_id',
            'target_id',
            'browser_binding_hash',
            'nonce',
            'code_verifier_sealed',
            'return_to',
            'expires_at',
          ])
          .executeTakeFirst(),
      { scope: 'auth' },
    );
    return row ?? null;
  }

  private async account(trx: Trx, userId: string): Promise<AccountRow | undefined> {
    return trx.selectFrom('platform.app_user').select([...ACCOUNT_COLUMNS]).where('id', '=', userId).forUpdate().executeTakeFirst();
  }

  private async activeMembership(trx: Trx, orgId: string, userId: string): Promise<boolean> {
    const row = await trx
      .selectFrom('platform.org_membership')
      .select('user_id')
      .where('organization_id', '=', orgId)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  private async invitationByToken(trx: Trx, token: string): Promise<InvitationRow | undefined> {
    return trx
      .selectFrom('platform.invitation')
      .select(['id', 'organization_id', 'user_id', 'email', 'used_at', 'revoked_at', 'expires_at'])
      .where('token_hash', '=', sha256(token))
      .executeTakeFirst();
  }

  private async invitationById(trx: Trx, id: string): Promise<InvitationRow | undefined> {
    return trx
      .selectFrom('platform.invitation')
      .select(['id', 'organization_id', 'user_id', 'email', 'used_at', 'revoked_at', 'expires_at'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  /** An invitation of the provider's organisation that is unused, not revoked and not expired. */
  private invitationUsable(invitation: InvitationRow, orgId: string, now: Date): boolean {
    return invitation.organization_id === orgId && invitation.used_at === null && invitation.revoked_at === null && invitation.expires_at.getTime() > now.getTime();
  }

  private async insertIdentity(
    trx: Trx,
    provider: ProviderRow,
    token: TokenIdentity,
    userId: string,
    method: 'invitation' | 'session' | 'jit',
    linkedBy: string | null,
    now: Date,
  ): Promise<void> {
    await trx
      .insertInto('platform.user_identity')
      .values({
        identity_provider_id: provider.id,
        subject: token.subject,
        user_id: userId,
        email_at_link: token.email,
        link_method: method,
        linked_by: linkedBy,
        linked_at: now,
      })
      .execute();
  }

  /** A free handle from the email's local part (`rina.kusuma`, then `rina.kusuma-2`, ...). */
  private async uniqueHandle(trx: Trx, email: string): Promise<string> {
    const base = handleBase(email);
    for (let n = 1; n < 1000; n += 1) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (!HANDLE.test(candidate)) continue;
      const taken = await trx.selectFrom('platform.app_user').select('id').where('handle', '=', candidate).executeTakeFirst();
      if (!taken) return candidate;
    }
    throw new SsoFailure('no_account', 'jit_no_free_handle');
  }

  /** An unexpected error of a callback: logged, and shown as `idp_error`. */
  private unexpected(error: unknown): SsoFailure {
    if (isUniqueViolation(error)) return new SsoFailure('idp_error', 'concurrent_sign_in');
    if (error instanceof ProblemError && error.slug === 'business-rule') return new SsoFailure('idp_error', `rule:${error.extras.rule ?? 'unknown'}`);
    this.logger.error(`OIDC callback failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return new SsoFailure('idp_error', 'internal');
  }

  /**
   * Audits a failed sign-in (`auth.login_failed`) of a transaction whose provider is known; failures before that
   * (unknown or replayed state) are only logged, since nothing ties them to an organisation.
   */
  private async recordFailure(failure: SsoFailure, transaction: TransactionRow | null, provider: ProviderRow | null): Promise<void> {
    const code: LoginErrorCode = failure.code;
    this.logger.log(`OIDC callback refused: ${code} (${failure.reason})`);
    const orgId = transaction?.organization_id ?? null;
    if (!transaction || !orgId) return;
    try {
      await this.audit.recordDetached({
        action: 'auth.login_failed',
        actor: { userId: transaction.user_id, kind: 'user' },
        organizationId: orgId,
        entityType: 'identity_provider',
        entityId: transaction.identity_provider_id,
        entityCode: provider?.id === transaction.identity_provider_id ? provider.slug : null,
        after: { method: 'oidc', flow: transaction.kind === 'oidc_link' ? 'link' : 'login', error: code, reason: failure.reason },
      });
    } catch (error) {
      this.logger.error(`Could not audit a refused OIDC callback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
