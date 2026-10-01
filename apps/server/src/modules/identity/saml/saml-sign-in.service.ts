// SAML 2.0 sign-in, invitation redemption through a provider and identity linking (build plan F.9, F.8 step 4,
// F.5, D-25, D-26). SP-initiated only: an AuthnRequest through the HTTP-Redirect binding, the response through the
// HTTP-POST binding to the ACS.
//
// 1. `start` (and the link starter of `POST /me/identities/{slug}/link`) writes an `auth_transaction` (`saml_login`
//    or `saml_link`) with the SHA-256 of a random state (sent as `RelayState`) and of a browser binding value, the
//    AuthnRequest id (`saml_request_id`), the relative return path and, for an invitation, its id. The binding value
//    goes to the cookie `mscd_saml_tx` (HttpOnly, Secure, SameSite=None, path `/api/v1/auth/saml/`, 10 minutes):
//    browsers do not send SameSite=Lax cookies with the identity provider's cross-site form post.
// 2. `acs` deletes the transaction by the RelayState hash (single use), checks the binding cookie and the expiry,
//    then lets `@node-saml/node-saml` check the XML signature of the assertion (signed assertions required), the
//    `Conditions` timestamps (60 seconds of skew) and the audience (the SP entity id). The rules here check the
//    issuer, the assertion id against `platform.saml_assertion_seen` (committed at once, so a replay fails even when
//    the first use failed later), the bearer confirmation's `InResponseTo` (the transaction's request id) and
//    `Recipient` (this ACS), and the persistent NameID.
// 3. The account is found by (provider, NameID) only: an existing link, the user of a link transaction, or an
//    invitation of the provider's organisation. SAML assertions never prove `email_verified`, so there is no JIT and
//    no email match (F.9). Anything else is `no_account`.
// 4. MFA from `AuthnContextClassRef`, else the local TOTP step or `mfa_required_by_policy`; then a session pinned to
//    the provider's organisation (D-26).
//
// Every failure redirects to `/login?error=<code>` and changes nothing but the consumed transaction and the
// assertion id cache.
import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { IdentityLinkStart, LoginErrorCode, SsoStartQuery } from '@mscd/shared';
import { SAML, ValidateInResponseTo, type Profile as SamlProfile } from '@node-saml/node-saml';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MscdConfig } from '../../../config/mscd-config';
import { Clock } from '../../../common/clock';
import { NotFoundError, ProblemError } from '../../../common/problems';
import { AUDIT_WRITER, LICENCE_GATE, type AuditWriter, type LicenceGate, type Trx } from '../../../common/tokens';
import { TenantScope } from '../../tenancy/tenant-scope';
import { AccountMailer } from '../account-mailer';
import { AuthService } from '../auth.service';
import { MfaService } from '../mfa.service';
import { SessionService, type CurrentSession, type IssuedSession } from '../session.service';
import { randomToken, sameBytes, sha256 } from '../tokens';
import { IdentityLinkRegistry, type IdentityLinkStarter, type LinkableProvider } from '../oidc/identity-link.registry';
import { loginErrorPath, safeReturnPath, SsoFailure } from '../oidc/oidc-rules';
import { providerBySlug, providerUsable, type ProviderRow } from '../oidc/provider-lookup';
import {
  assertionFacts,
  checkIssuer,
  checkSubjectConfirmation,
  decideSamlMfa,
  PERSISTENT_NAMEID_FORMAT,
  replayCacheExpiry,
  responseInResponseTo,
  SAML_CLOCK_SKEW_MS,
  samlSubjectOf,
} from './saml-rules';

/** Cookie of the browser binding of a SAML transaction (F.9). */
export const SAML_TX_COOKIE = 'mscd_saml_tx';
/** The cookie is sent only to the SAML routes (the ACS). */
export const SAML_TX_COOKIE_PATH = '/api/v1/auth/saml/';
/** Lifetime of a SAML transaction and its binding cookie (F.9). */
export const SAML_TX_TTL_MS = 10 * 60_000;

/** Path of the assertion consumer service of a provider; the ACS URL is `<http.public_url><path>`. */
export function samlAcsPath(slug: string): string {
  return `/api/v1/auth/saml/${encodeURIComponent(slug)}/acs`;
}

/** Path of the SP metadata of a provider (also the default SP entity id). */
export function samlMetadataPath(slug: string): string {
  return `/api/v1/auth/saml/${encodeURIComponent(slug)}/metadata`;
}

/** Second-factor pages of the web that take over the CSRF token of the new session in the fragment (WP-38). */
const MFA_PAGE = '/login/mfa';
const ENROL_PAGE = '/login/enrol';

/** What the controller sends: a redirect, with the session to set when one was created. */
export interface SamlRedirect {
  location: string;
  session?: IssuedSession;
}

type SamlTransactionKind = 'saml_login' | 'saml_link';

interface TransactionRow {
  id: string;
  kind: string;
  identity_provider_id: string | null;
  organization_id: string | null;
  user_id: string | null;
  target_id: string | null;
  browser_binding_hash: Buffer;
  saml_request_id: string | null;
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

/** What the assertion says about the person, after the F.9 rules. */
interface AssertedIdentity {
  subject: string;
  /** The asserted email, kept for the audit trail only; never used to find or link an account (F.9). */
  email: string | null;
  authnContextClassRefs: string[];
}

const ACCOUNT_COLUMNS = ['id', 'handle', 'email', 'kind', 'status', 'mfa_required', 'deleted_at'] as const;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown })?.code === '23505';
}

/** An AuthnRequest id: an NCName (a letter or underscore first), 41 characters. */
function newRequestId(): string {
  return `_${randomBytes(20).toString('hex')}`;
}

/** The settings of one provider for `@node-saml/node-saml`. */
interface SamlSettings {
  entryPoint: string;
  spEntityId: string;
  acsUrl: string;
  idpCerts: string[];
  idpIssuer: string | null;
}

@Injectable()
export class SamlSignInService implements OnModuleInit {
  private readonly logger = new Logger('SamlSignIn');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly mailer: AccountMailer,
    private readonly links: IdentityLinkRegistry,
  ) {}

  onModuleInit(): void {
    const starter: IdentityLinkStarter = { start: (current, provider, reply) => this.startLink(current, provider, reply) };
    this.links.register('saml', starter);
  }

  private publicUrl(): string {
    return this.config.profile.http.public_url.replace(/\/+$/, '');
  }

  /** The ACS URL sent in the AuthnRequest and expected as `Recipient`: `<http.public_url>/api/v1/auth/saml/<slug>/acs`. */
  acsUrl(slug: string): string {
    return `${this.publicUrl()}${samlAcsPath(slug)}`;
  }

  /** The SP entity id of a provider: `saml_sp_entity_id`, else the URL of its SP metadata. */
  spEntityId(provider: Pick<ProviderRow, 'slug' | 'saml_sp_entity_id'>): string {
    return provider.saml_sp_entity_id ?? `${this.publicUrl()}${samlMetadataPath(provider.slug)}`;
  }

  private settingsOf(provider: ProviderRow): SamlSettings {
    if (!provider.saml_entry_point || !provider.saml_idp_certs || provider.saml_idp_certs.length === 0) {
      throw new SsoFailure('idp_error', 'provider_incomplete');
    }
    return {
      entryPoint: provider.saml_entry_point,
      spEntityId: this.spEntityId(provider),
      acsUrl: this.acsUrl(provider.slug),
      idpCerts: [...provider.saml_idp_certs],
      idpIssuer: provider.saml_idp_issuer,
    };
  }

  /**
   * The library instance of one provider and one step. InResponseTo is checked by the rules of this service against
   * the transaction (the library's request id cache is not used); the AuthnRequest is unsigned and asks for the
   * persistent NameID without a requested authentication context, so the identity provider applies its own policy.
   */
  private library(settings: SamlSettings, options: { forceAuthn?: boolean; requestId?: string } = {}): SAML {
    return new SAML({
      entryPoint: settings.entryPoint,
      issuer: settings.spEntityId,
      callbackUrl: settings.acsUrl,
      audience: settings.spEntityId,
      idpCert: settings.idpCerts,
      ...(settings.idpIssuer ? { idpIssuer: settings.idpIssuer } : {}),
      identifierFormat: PERSISTENT_NAMEID_FORMAT,
      allowCreate: true,
      disableRequestedAuthnContext: true,
      forceAuthn: options.forceAuthn ?? false,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
      validateInResponseTo: ValidateInResponseTo.never,
      generateUniqueId: () => options.requestId ?? newRequestId(),
      signatureAlgorithm: 'sha256',
    });
  }

  // ------------------------------------------------------------------------------------------------ binding cookie

  private cookieOptions() {
    const secure = this.config.profile.security.cookie_secure;
    // SameSite=None needs Secure; without it (plain-HTTP demo and test profiles) the cookie is Lax (F.9).
    return { path: SAML_TX_COOKIE_PATH, httpOnly: true, secure, sameSite: secure ? ('none' as const) : ('lax' as const) };
  }

  /** Sets the binding cookie of a new transaction (F.9). */
  setBindingCookie(reply: FastifyReply, binding: string): void {
    reply.setCookie(SAML_TX_COOKIE, binding, { ...this.cookieOptions(), maxAge: SAML_TX_TTL_MS / 1000 });
  }

  /** Clears the binding cookie (every ACS post, whatever its outcome). */
  clearBindingCookie(reply: FastifyReply): void {
    reply.clearCookie(SAML_TX_COOKIE, this.cookieOptions());
  }

  // ------------------------------------------------------------------------------------------------------- metadata

  /**
   * `GET /auth/saml/{slug}/metadata`: the SP metadata of a SAML provider of an organisation that is not archived
   * (also while the provider is disabled, so the identity provider side can be set up first). 404 otherwise.
   */
  async metadata(slug: string): Promise<string> {
    const provider = await this.scope.withPlatform((trx) => providerBySlug(trx, slug), { scope: 'auth' });
    if (!provider || !providerUsable(this.config.profile, { ...provider, enabled: true }, 'saml')) throw new NotFoundError('Unknown identity provider');
    let settings: SamlSettings;
    try {
      settings = this.settingsOf(provider);
    } catch {
      throw new NotFoundError('Unknown identity provider');
    }
    return this.library(settings).generateServiceProviderMetadata(null, null);
  }

  // ---------------------------------------------------------------------------------------------------------- start

  /**
   * `GET /auth/saml/{slug}/start`: 404 for an unknown, disabled or non-SAML provider. An invitation token that is not
   * a valid invitation of the provider's organisation redirects to the login page with `invitation_invalid`;
   * otherwise the browser goes to the identity provider with an AuthnRequest.
   */
  async start(reply: FastifyReply, slug: string, query: SsoStartQuery): Promise<SamlRedirect> {
    const now = this.clock.now();
    const prepared = await this.scope.withPlatform(
      async (trx) => {
        const provider = await providerBySlug(trx, slug);
        if (!provider || !providerUsable(this.config.profile, provider, 'saml')) return null;
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
      const location = await this.openTransaction(reply, prepared.provider, {
        kind: 'saml_login',
        userId: null,
        invitationId: prepared.invitationId,
        returnTo: safeReturnPath(query.returnTo),
      });
      return { location };
    } catch (error) {
      this.logger.warn(`SAML sign-in with ${slug} could not start: ${error instanceof Error ? error.message : String(error)}`);
      return { location: loginErrorPath('idp_error') };
    }
  }

  /**
   * The SAML starter of `IdentityLinkRegistry` (`POST /me/identities/{slug}/link`; the OIDC controller has checked
   * the provider, the membership and the recent proof): a `saml_link` transaction for the session user.
   */
  async startLink(current: CurrentSession, provider: LinkableProvider, reply: FastifyReply): Promise<IdentityLinkStart> {
    const row = await this.scope.withPlatform((trx) => providerBySlug(trx, provider.slug), { scope: 'auth', userId: current.row.user_id });
    if (!row || row.id !== provider.id || !providerUsable(this.config.profile, row, 'saml')) throw new NotFoundError('Unknown identity provider');
    let redirectUrl: string;
    try {
      redirectUrl = await this.openTransaction(reply, row, { kind: 'saml_link', userId: current.row.user_id, invitationId: null, returnTo: '/' });
    } catch (error) {
      this.logger.warn(`Identity link with ${row.slug} could not start: ${error instanceof Error ? error.message : String(error)}`);
      throw new ProblemError('dependency-unavailable', { detail: 'The identity provider settings are incomplete; ask your administrator' });
    }
    return { redirectUrl };
  }

  /** Writes a transaction, sets the binding cookie and returns the HTTP-Redirect URL of the AuthnRequest. */
  private async openTransaction(
    reply: FastifyReply,
    provider: ProviderRow,
    input: { kind: SamlTransactionKind; userId: string | null; invitationId: string | null; returnTo: string },
  ): Promise<string> {
    const settings = this.settingsOf(provider);
    const now = this.clock.now();
    const state = randomToken();
    const binding = randomToken();
    const requestId = newRequestId();
    // A link or an invitation binds the identity to an account for good: the person signs in at the provider now, so
    // an earlier provider session in this browser (someone else's, on a shared computer) is never linked.
    const forceAuthn = input.kind === 'saml_link' || input.invitationId !== null;
    const url = await this.library(settings, { forceAuthn, requestId }).getAuthorizeUrlAsync(state, undefined, {});
    await this.scope.withPlatform(
      (trx) =>
        trx
          .insertInto('platform.auth_transaction')
          .values({
            id: randomUUID(),
            kind: input.kind,
            identity_provider_id: provider.id,
            organization_id: provider.organization_id,
            user_id: input.userId,
            target_id: input.invitationId,
            state_hash: sha256(state),
            browser_binding_hash: sha256(binding),
            saml_request_id: requestId,
            return_to: input.returnTo,
            created_at: now,
            expires_at: new Date(now.getTime() + SAML_TX_TTL_MS),
          })
          .execute(),
      { scope: 'auth', userId: input.userId },
    );
    this.setBindingCookie(reply, binding);
    return url;
  }

  // ------------------------------------------------------------------------------------------------------------ ACS

  /**
   * `POST /auth/saml/{slug}/acs`: returns where to redirect. Never throws for a failed sign-in: every failure is a
   * redirect to `/login?error=<code>`.
   */
  async acs(request: FastifyRequest, slug: string, body: { SAMLResponse: string; RelayState?: string }): Promise<SamlRedirect> {
    const binding = request.cookies?.[SAML_TX_COOKIE];
    const transaction = body.RelayState ? await this.consumeTransaction(body.RelayState) : null;
    let provider: ProviderRow | null = null;
    try {
      if (!transaction) throw new SsoFailure('expired', body.RelayState ? 'transaction_not_found' : 'relay_state_missing');
      provider = await this.scope.withPlatform((trx) => providerBySlug(trx, slug).then((p) => p ?? null), { scope: 'auth' });
      return await this.completeAcs(request, transaction, provider, binding, body.SAMLResponse);
    } catch (error) {
      const failure = error instanceof SsoFailure ? error : this.unexpected(error);
      await this.recordFailure(failure, transaction, provider);
      return { location: loginErrorPath(failure.code) };
    }
  }

  private async completeAcs(
    request: FastifyRequest,
    transaction: TransactionRow,
    provider: ProviderRow | null,
    binding: string | undefined,
    samlResponse: string,
  ): Promise<SamlRedirect> {
    const now = this.clock.now();
    if (transaction.expires_at.getTime() <= now.getTime()) throw new SsoFailure('expired', 'transaction_expired');
    if (typeof binding !== 'string' || binding === '' || !sameBytes(sha256(binding), transaction.browser_binding_hash)) {
      throw new SsoFailure('expired', 'binding_mismatch');
    }
    if (!provider || provider.id !== transaction.identity_provider_id) throw new SsoFailure('expired', 'provider_mismatch');
    if (!providerUsable(this.config.profile, provider, 'saml')) throw new SsoFailure('idp_error', 'provider_disabled');
    if (!transaction.saml_request_id) throw new SsoFailure('expired', 'transaction_incomplete');

    const identity = await this.validate(provider, transaction.saml_request_id, samlResponse);
    if (transaction.kind === 'saml_link') return this.completeLink(transaction, provider, identity);
    return this.completeLogin(request, transaction, provider, identity);
  }

  /** F.9: signature, timestamps and audience (library), then issuer, replay cache, InResponseTo, NameID (rules). */
  private async validate(provider: ProviderRow, requestId: string, samlResponse: string): Promise<AssertedIdentity> {
    const settings = this.settingsOf(provider);
    let profile: SamlProfile | null;
    try {
      ({ profile } = await this.library(settings).validatePostResponseAsync({ SAMLResponse: samlResponse }));
    } catch (error) {
      throw new SsoFailure('idp_error', `assertion_invalid:${this.libraryReason(error)}`);
    }
    if (!profile || typeof profile.getAssertion !== 'function') throw new SsoFailure('idp_error', 'assertion_missing');
    const facts = assertionFacts(profile.getAssertion());
    checkIssuer(facts, settings.idpIssuer);
    const keepUntil = replayCacheExpiry(facts);

    // The assertion id is recorded in its own committed transaction before any later check, so a replay fails even
    // when the first use of the assertion failed afterwards.
    const fresh = await this.scope.withPlatform(
      async (trx) => {
        const inserted = await trx
          .insertInto('platform.saml_assertion_seen')
          .values({ identity_provider_id: provider.id, assertion_id_hash: sha256(facts.id), expires_at: keepUntil })
          .onConflict((oc) => oc.columns(['identity_provider_id', 'assertion_id_hash']).doNothing())
          .returning('expires_at')
          .executeTakeFirst();
        return inserted !== undefined;
      },
      { scope: 'auth' },
    );
    if (!fresh) throw new SsoFailure('expired', 'assertion_replayed');

    const xml = Buffer.from(samlResponse, 'base64').toString('utf8');
    // The library checks the assertion's timestamps against the system clock; the confirmation uses the same clock, so
    // both checks agree (the application clock only differs from it in tests).
    checkSubjectConfirmation(facts, { requestId, acsUrl: settings.acsUrl, responseInResponseTo: responseInResponseTo(xml), now: new Date() });
    return { subject: samlSubjectOf(facts), email: facts.email, authnContextClassRefs: facts.authnContextClassRefs };
  }

  /** A short reason of a library error for the audit trail (no assertion content). */
  private libraryReason(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/audience/i.test(message)) return 'audience_mismatch';
    if (/signature/i.test(message)) return 'signature_invalid';
    if (/expired|not yet valid|too old/i.test(message)) return 'not_valid_now';
    if (/SAML provider returned/i.test(message)) return 'status_not_success';
    if (/multiple/i.test(message)) return 'multiple_assertions';
    if (/Missing SAML assertion/i.test(message)) return 'assertion_missing';
    if (/decrypt/i.test(message)) return 'encrypted_assertion';
    return 'malformed';
  }

  /** F.8 steps 4 to 6 for a sign-in transaction (F.9). */
  private async completeLogin(request: FastifyRequest, transaction: TransactionRow, provider: ProviderRow, identity: AssertedIdentity): Promise<SamlRedirect> {
    const now = this.clock.now();
    const orgId = provider.organization_id;
    const presented = this.sessions.readCookie(request);
    const issued = await this.scope.withPlatform(
      async (trx) => {
        const account = await this.resolveAccount(trx, transaction, provider, identity, now);
        if (account.kind !== 'person' || account.status !== 'active' || account.deleted_at !== null) {
          throw new SsoFailure('no_account', `account_${account.deleted_at ? 'deleted' : account.kind === 'person' ? account.status : account.kind}`);
        }
        if (!(await this.activeMembership(trx, orgId, account.id))) throw new SsoFailure('no_account', 'not_a_member');

        const decision = decideSamlMfa(identity.authnContextClassRefs, provider);
        if (decision.kind === 'reject') throw new SsoFailure('mfa_required_by_policy', 'mfa_context_missing');
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
          authMethod: 'saml',
          identityProviderId: provider.id,
          // The session's `amr` records an MFA proof of the identity provider; SAML has no amr claim.
          amr: decision.kind === 'idp' ? ['mfa'] : [],
        });
        await trx
          .updateTable('platform.user_identity')
          .set({ last_login_at: now })
          .where('identity_provider_id', '=', provider.id)
          .where('subject', '=', identity.subject)
          .execute();
        if (state === 'active') {
          await this.auth.recordLogin(trx, account.id, orgId, now, {
            method: 'saml',
            identityProviderId: provider.id,
            provider: provider.slug,
            subject: identity.subject,
            secondFactor: decision.kind === 'idp' ? 'idp_mfa' : 'none',
            authnContext: identity.authnContextClassRefs,
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
   * F.8 step 4 for SAML, first match wins: an existing link of (provider, NameID); an invitation of the provider's
   * organisation. No JIT and never by email (F.9).
   */
  private async resolveAccount(trx: Trx, transaction: TransactionRow, provider: ProviderRow, identity: AssertedIdentity, now: Date): Promise<AccountRow> {
    const linked = await trx
      .selectFrom('platform.user_identity')
      .select('user_id')
      .where('identity_provider_id', '=', provider.id)
      .where('subject', '=', identity.subject)
      .forUpdate()
      .executeTakeFirst();
    if (linked) {
      const account = await this.account(trx, linked.user_id);
      if (!account) throw new SsoFailure('no_account', 'account_missing');
      // The invitation of a pre-registered subject is still redeemed, but only by the invitation's own user (as OIDC).
      if (transaction.target_id) {
        const invitation = await this.invitationById(trx, transaction.target_id);
        if (!invitation || !this.invitationUsable(invitation, provider.organization_id, now) || invitation.user_id !== account.id) {
          throw new SsoFailure('invitation_invalid', 'invitation_other_user');
        }
        return this.redeemInvitation(trx, invitation, account, provider, identity, now, { linkIdentity: false });
      }
      return account;
    }

    if (transaction.target_id) {
      const invitation = await this.invitationById(trx, transaction.target_id);
      if (!invitation || !this.invitationUsable(invitation, provider.organization_id, now)) throw new SsoFailure('invitation_invalid', 'invitation_unusable');
      const account = await this.account(trx, invitation.user_id);
      if (!account || account.kind !== 'person' || account.status === 'disabled' || account.deleted_at !== null) {
        throw new SsoFailure('invitation_invalid', 'invitation_account_unusable');
      }
      return this.redeemInvitation(trx, invitation, account, provider, identity, now, { linkIdentity: true });
    }

    throw new SsoFailure('no_account', 'no_link');
  }

  /**
   * F.8 step 4 invitation path: links the NameID (unless it is linked already), activates the membership (after the
   * licence user check, D-15) and the account, and marks the invitation used.
   */
  private async redeemInvitation(
    trx: Trx,
    invitation: InvitationRow,
    account: AccountRow,
    provider: ProviderRow,
    identity: AssertedIdentity,
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
    if (options.linkIdentity) await this.insertIdentity(trx, provider, identity, account.id, 'invitation', null, now);
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
        after: { provider: provider.slug, identityProviderId: provider.id, subject: identity.subject, linkMethod: 'invitation', invitationId: invitation.id },
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
   * F.8 step 4 link path: links the NameID to the transaction's user. The ACS is a cross-site form post, which never
   * carries the SameSite=Lax session cookie, so the browser is identified by the binding cookie that the signed-in
   * `POST /me/identities/{slug}/link` set; the user must still be an active person and member. An existing link of
   * the same user is kept; a NameID linked to another account is refused.
   */
  private async completeLink(transaction: TransactionRow, provider: ProviderRow, identity: AssertedIdentity): Promise<SamlRedirect> {
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
          .where('subject', '=', identity.subject)
          .forUpdate()
          .executeTakeFirst();
        if (linked) {
          if (linked.user_id !== userId) throw new SsoFailure('idp_error', 'subject_linked_to_another_account');
          return;
        }
        await this.insertIdentity(trx, provider, identity, userId, 'session', userId, now);
        await this.audit.record(trx, {
          action: 'identity.linked',
          actor: { userId, kind: 'user' },
          organizationId: provider.organization_id,
          entityType: 'user',
          entityId: userId,
          entityCode: account.handle,
          after: { provider: provider.slug, identityProviderId: provider.id, subject: identity.subject, linkMethod: 'session' },
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

  /** Deletes the transaction of a RelayState (single use) and returns it, or null. */
  private async consumeTransaction(relayState: string): Promise<TransactionRow | null> {
    const row = await this.scope.withPlatform(
      (trx) =>
        trx
          .deleteFrom('platform.auth_transaction')
          .where('state_hash', '=', sha256(relayState))
          .where('kind', 'in', ['saml_login', 'saml_link'])
          .returning([
            'id',
            'kind',
            'identity_provider_id',
            'organization_id',
            'user_id',
            'target_id',
            'browser_binding_hash',
            'saml_request_id',
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

  /** `email_at_link` stays null: a SAML assertion never proves the email (F.9). */
  private async insertIdentity(
    trx: Trx,
    provider: ProviderRow,
    identity: AssertedIdentity,
    userId: string,
    method: 'invitation' | 'session',
    linkedBy: string | null,
    now: Date,
  ): Promise<void> {
    await trx
      .insertInto('platform.user_identity')
      .values({ identity_provider_id: provider.id, subject: identity.subject, user_id: userId, email_at_link: null, link_method: method, linked_by: linkedBy, linked_at: now })
      .execute();
  }

  /** An unexpected error of an ACS post: logged, and shown as `idp_error`. */
  private unexpected(error: unknown): SsoFailure {
    if (isUniqueViolation(error)) return new SsoFailure('idp_error', 'concurrent_sign_in');
    if (error instanceof ProblemError && error.slug === 'business-rule') return new SsoFailure('idp_error', `rule:${error.extras.rule ?? 'unknown'}`);
    this.logger.error(`SAML ACS failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return new SsoFailure('idp_error', 'internal');
  }

  /**
   * Audits a refused ACS post (`auth.login_failed`) of a transaction whose provider is known; failures before that
   * (unknown or replayed RelayState) are only logged, since nothing ties them to an organisation.
   */
  private async recordFailure(failure: SsoFailure, transaction: TransactionRow | null, provider: ProviderRow | null): Promise<void> {
    const code: LoginErrorCode = failure.code;
    this.logger.log(`SAML ACS refused: ${code} (${failure.reason})`);
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
        after: { method: 'saml', flow: transaction.kind === 'saml_link' ? 'link' : 'login', error: code, reason: failure.reason },
      });
    } catch (error) {
      this.logger.error(`Could not audit a refused SAML ACS post: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
