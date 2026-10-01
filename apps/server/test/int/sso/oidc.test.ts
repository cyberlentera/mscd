// OIDC sign-in against Keycloak (build plan F.8, F.5, D-25, D-26, WP-16). Runs with MSCD_TEST_SSO=1, which starts
// keycloak/keycloak:26.7.5 with the realm of the developer stack once per run (test/setup/keycloak.ts). Each test
// drives the full browser flow: the api's start route (light-my-request with a cookie jar), the Keycloak sign-in
// pages (real HTTP with a cookie jar), then the api's callback with the redirect Keycloak sent, and the local TOTP
// step where the provider sends no MFA proof.
import { randomBytes, randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { Insertable } from 'kysely';
import { Logger } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { Clock } from '../../../src/common/clock';
import { LICENCE_GATE } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { IdentityProviderTable } from '../../../src/db/types/platform';
import { AdminIdpModule } from '../../../src/modules/admin-idp/admin-idp.module';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { InvitationService } from '../../../src/modules/identity/invitation.service';
import { amrProvesMfa, decideSsoMfa, subjectOf, verifiedEmailOf } from '../../../src/modules/identity/oidc/oidc-rules';
import { sha256 } from '../../../src/modules/identity/tokens';
import { SessionService } from '../../../src/modules/identity/session.service';
import { base32Decode, totpAt } from '../../../src/modules/identity/totp';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { SecretBox } from '../../../src/modules/keys/secret-box';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { inScope } from '../db/helpers';
import {
  APP_ORIGIN,
  auditActions,
  Browser,
  codeAt,
  FakeLicenceGate,
  mutableClock,
  openSessions,
  resetRateLimits,
  sessionRow,
  signIn,
  startMailpit,
  type IdentityApp,
  type Mailpit,
  type TestUser,
  addUser as addLocalUser,
} from '../identity/helpers';
import { createTenant } from '../../setup/global-db';
import {
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  KEYCLOAK_SUBJECTS,
  KeycloakAdmin,
  KeycloakBrowser,
  signInAtKeycloak,
  type KeycloakSignIn,
} from '../../setup/keycloak';
import { useTestDatabase, type TestDatabase } from '../../setup/test-db';

const keycloak = inject('mscdKeycloak');
const BINDING_COOKIE = 'mscd_auth_tx';
const ACCEPTED_AMR = ['pwd', 'otp', 'hwk', 'swk', 'fpt', 'face', 'pin', 'sms', 'mca'];

// ---------------------------------------------------------------------------------------------------------------
// Rules without Keycloak (F.5, F.8 step 3)
// ---------------------------------------------------------------------------------------------------------------

describe('OIDC rules', () => {
  it('accepts the amr claim as MFA proof only with mfa or two accepted values', () => {
    expect(amrProvesMfa(['otp'], ACCEPTED_AMR)).toBe(false);
    expect(amrProvesMfa(['pwd'], ACCEPTED_AMR)).toBe(false);
    expect(amrProvesMfa(['otp', 'otp'], ACCEPTED_AMR)).toBe(false);
    expect(amrProvesMfa(['pwd', 'unknown'], ACCEPTED_AMR)).toBe(false);
    expect(amrProvesMfa(['pwd', 'otp'], ACCEPTED_AMR)).toBe(true);
    expect(amrProvesMfa(['mfa'], ACCEPTED_AMR)).toBe(true);
    expect(amrProvesMfa(['pwd', 'otp'], ['pwd'])).toBe(false);
    expect(amrProvesMfa([], ACCEPTED_AMR)).toBe(false);
  });

  it('decides the second factor from the provider policy', () => {
    const base = { require_mfa_claim: true, accepted_amr: ACCEPTED_AMR, mfa_fallback: 'local_totp' as const };
    expect(decideSsoMfa(['pwd', 'otp'], base)).toEqual({ kind: 'idp' });
    expect(decideSsoMfa(['otp'], base)).toEqual({ kind: 'local_totp' });
    expect(decideSsoMfa(['otp'], { ...base, mfa_fallback: 'reject' })).toEqual({ kind: 'reject' });
    // Without require_mfa_claim the claim is ignored: the local TOTP step always follows.
    expect(decideSsoMfa(['pwd', 'otp'], { ...base, require_mfa_claim: false })).toEqual({ kind: 'local_totp' });
  });

  it('takes the subject from sub, or tid and oid for Entra ID', () => {
    const tid = '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c';
    const oid = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    expect(subjectOf({ sub: 'abc' }, { subject_mode: 'sub', entra_tenant_id: null })).toBe('abc');
    expect(subjectOf({ sub: 'pairwise', tid: tid.toUpperCase(), oid }, { subject_mode: 'entra', entra_tenant_id: tid })).toBe(`${tid}:${oid}`);
    expect(() => subjectOf({ sub: 'x', tid: randomUUID(), oid }, { subject_mode: 'entra', entra_tenant_id: tid })).toThrow(/idp_error/);
    expect(() => subjectOf({ sub: 'x' }, { subject_mode: 'entra', entra_tenant_id: tid })).toThrow(/idp_error/);
    expect(() => subjectOf({}, { subject_mode: 'sub', entra_tenant_id: null })).toThrow(/idp_error/);
  });

  it('uses an email only when email_verified is true', () => {
    expect(verifiedEmailOf({ email: 'Rina@Example.CO.ID', email_verified: true })).toBe('rina@example.co.id');
    expect(verifiedEmailOf({ email: 'rina@example.co.id', email_verified: false })).toBeNull();
    expect(verifiedEmailOf({ email: 'rina@example.co.id' })).toBeNull();
    expect(verifiedEmailOf({ email: 'rina@example.co.id', email_verified: 'true' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Application and fixtures
// ---------------------------------------------------------------------------------------------------------------

async function createSsoApp(db: TestDatabase, mail: Mailpit | null): Promise<IdentityApp> {
  const env: Record<string, string> = mail ? { MSCD__MAIL__SMTP__HOST: mail.host, MSCD__MAIL__SMTP__PORT: String(mail.smtpPort) } : { MSCD__MAIL__SMTP__PORT: '9' };
  const config = db.config(env);
  const clock = mutableClock(config, new Date());
  const licence = new FakeLicenceGate();

  @Global()
  @Module({ providers: [{ provide: LICENCE_GATE, useValue: licence }], exports: [LICENCE_GATE] })
  class FakeLicenceModule {}

  const moduleRef: TestingModule = await db
    .createTestingModule({ imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, AdminIdpModule, FakeLicenceModule] }, env)
    .overrideProvider(Clock)
    .useValue(clock.clock)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, moduleRef, clock, licence, close: () => app.close() };
}

/** A path of the app from an absolute URL under `http.public_url`. */
function appPath(url: string): string {
  expect(url.startsWith(`${APP_ORIGIN}/`), url).toBe(true);
  return url.slice(APP_ORIGIN.length);
}

/** The CSRF token handed over in the fragment of `/login/mfa#csrf=` or `/login/enrol#csrf=`. */
function fragmentCsrf(location: string): string {
  const match = /#csrf=([A-Za-z0-9_-]+)$/.exec(location);
  if (!match) throw new Error(`No CSRF token in ${location}`);
  return match[1]!;
}

const describeSso = describe.skipIf(!keycloak);

describeSso('OIDC sign-in with Keycloak', () => {
  const db = useTestDatabase('empty');
  const kc = keycloak!;
  const admin = new KeycloakAdmin(kc);
  let ctx: IdentityApp;
  let mail: Mailpit;
  let orgA: CreatedTenant;
  let orgB: CreatedTenant;
  let providerA: string;
  let providerB: string;
  const keycloakUsers: string[] = [];

  beforeAll(async () => {
    mail = await startMailpit();
    orgA = await createTenant(db, 'ssoa');
    orgB = await createTenant(db, 'ssob');
    ctx = await createSsoApp(db, mail);
    providerA = await addProvider(orgA.id, 'kc-a');
    providerB = await addProvider(orgB.id, 'kc-b');
  });

  afterAll(async () => {
    await ctx?.close();
    await mail?.stop();
    for (const id of keycloakUsers) await admin.deleteUser(id).catch(() => undefined);
  });

  beforeEach(async () => {
    await resetRateLimits(db);
  });

  // ------------------------------------------------------------------------------------------------- fixtures

  async function addProvider(orgId: string, slug: string, values: Partial<Insertable<IdentityProviderTable>> = {}): Promise<string> {
    const id = randomUUID();
    const sealed = await ctx.moduleRef.get(SecretBox).seal(KEYCLOAK_CLIENT_SECRET, { purpose: 'idp', providerId: id });
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx
        .insertInto('platform.identity_provider')
        .values({
          id,
          organization_id: orgId,
          slug,
          kind: 'oidc',
          display_name: `Sign in with ${slug}`,
          icon: 'generic',
          oidc_issuer: kc.issuer,
          oidc_client_id: KEYCLOAK_CLIENT_ID,
          oidc_client_secret_sealed: sealed,
          ...values,
        })
        .execute(),
    );
    return id;
  }

  async function updateProvider(id: string, values: Partial<Insertable<IdentityProviderTable>>): Promise<void> {
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.identity_provider').set(values).where('id', '=', id).execute());
  }

  /** A Keycloak user with a unique name; returns its subject and sign-in. */
  async function keycloakUser(options: { email?: string; emailVerified?: boolean; requiredActions?: string[] } = {}): Promise<{ sub: string; login: KeycloakSignIn; email: string }> {
    const username = `kc-${randomBytes(5).toString('hex')}`;
    const email = options.email ?? `${username}@keycloak.test`;
    const sub = await admin.createUser({ username, email, emailVerified: options.emailVerified ?? true, requiredActions: options.requiredActions });
    keycloakUsers.push(sub);
    return { sub, email, login: { username, totp: { secret: null } } };
  }

  /** A person of the given organisations, with a password and optionally a TOTP factor. */
  function addUser(handle: string, orgs: CreatedTenant[], options: { factor?: boolean; status?: 'active' | 'invited' | 'disabled' } = {}): Promise<TestUser> {
    return addLocalUser(db, ctx.moduleRef, { handle, memberships: orgs.map((org) => ({ org })), factor: options.factor ?? false, ...(options.status ? { status: options.status } : {}) });
  }

  async function preRegister(providerId: string, subject: string, userId: string): Promise<void> {
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.user_identity').values({ identity_provider_id: providerId, subject, user_id: userId, link_method: 'admin' }).execute(),
    );
  }

  async function identities(userId: string) {
    return inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.user_identity').selectAll().where('user_id', '=', userId).execute());
  }

  /** `GET /auth/oidc/{slug}/start`; returns the response (302 to Keycloak, or to the login page). */
  function start(browser: Browser, slug: string, query: Record<string, string> = {}) {
    const search = new URLSearchParams(query).toString();
    return browser.get(`/api/v1/auth/oidc/${slug}/start${search ? `?${search}` : ''}`);
  }

  /** Signs in at Keycloak from a start response and returns the callback path Keycloak redirected to. */
  async function atKeycloak(startResponse: { statusCode: number; headers: Record<string, unknown> }, login: KeycloakSignIn): Promise<string> {
    expect(startResponse.statusCode).toBe(302);
    const authorizationUrl = String(startResponse.headers.location);
    expect(authorizationUrl.startsWith(`${kc.issuer}/protocol/openid-connect/auth?`)).toBe(true);
    return appPath(await signInAtKeycloak(new KeycloakBrowser(), authorizationUrl, login));
  }

  /** The full flow: start, Keycloak, callback. Returns the callback's redirect target. */
  async function ssoSignIn(browser: Browser, slug: string, login: KeycloakSignIn, query: Record<string, string> = {}): Promise<{ location: string; callbackPath: string }> {
    const callbackPath = await atKeycloak(await start(browser, slug, query), login);
    const done = await browser.get(callbackPath);
    expect(done.statusCode, done.body).toBe(302);
    return { location: String(done.headers.location), callbackPath };
  }

  async function auditOf(userId: string, action: string) {
    return (await auditActions(db, userId)).filter((a) => a.action === action);
  }

  async function providerFailures(providerId: string): Promise<{ error: string; reason: string }[]> {
    const rows = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').select('after_data').where('action', '=', 'auth.login_failed').where('entity_id', '=', providerId).orderBy('seq').execute(),
    );
    return rows.map((r) => r.after_data as unknown as { error: string; reason: string });
  }

  // ------------------------------------------------------------------------------------------------- sign-in

  it('signs in a pre-registered subject, continues with the local TOTP step and pins the session to the provider organisation', async () => {
    const user = await addUser('pre.reg', [orgB, orgA], { factor: true });
    const kcUser = await keycloakUser();
    await preRegister(providerA, kcUser.sub, user.id);
    const browser = new Browser(ctx.app);

    const startResponse = await start(browser, 'kc-a', { returnTo: '/controls?ms=isms' });
    const binding = browser.cookies.get(BINDING_COOKIE);
    expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const setCookie = String(startResponse.headers['set-cookie']);
    expect(setCookie).toContain('Path=/api/v1/auth/oidc/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const authorization = new URL(String(startResponse.headers.location));
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${APP_ORIGIN}/api/v1/auth/oidc/kc-a/callback`);
    expect(authorization.searchParams.get('scope')).toBe('openid email profile');
    expect(authorization.searchParams.get('nonce')).toBeTruthy();
    expect(authorization.searchParams.has('prompt')).toBe(false);
    // Only hashes of the state and the binding are stored; the PKCE verifier is sealed.
    const stored = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.auth_transaction').selectAll().where('state_hash', '=', sha256(authorization.searchParams.get('state')!)).executeTakeFirstOrThrow(),
    );
    expect(stored).toMatchObject({ kind: 'oidc_login', identity_provider_id: providerA, organization_id: orgA.id, user_id: null, return_to: '/controls?ms=isms' });
    expect(stored.browser_binding_hash.equals(sha256(binding!))).toBe(true);
    expect(stored.code_verifier_sealed).toMatch(/^v1\./);
    expect(stored.expires_at.getTime() - ctx.clock.now().getTime()).toBe(10 * 60_000);

    const callbackPath = await atKeycloak(startResponse, kcUser.login);
    const done = await browser.get(callbackPath);
    expect(done.statusCode).toBe(302);
    const location = String(done.headers.location);
    expect(location).toMatch(/^\/login\/mfa#csrf=[A-Za-z0-9_-]+$/);
    expect(browser.cookies.has(BINDING_COOKIE)).toBe(false);
    const pending = await sessionRow(db, browser.session!);
    expect(pending).toMatchObject({
      state: 'mfa_pending',
      auth_method: 'oidc',
      identity_provider_id: providerA,
      auth_org_id: orgA.id,
      organization_id: orgA.id,
      user_id: user.id,
    });
    expect(pending.amr).toEqual(['pwd']);
    // The transaction is gone (single use).
    const left = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.auth_transaction').select('id').where('id', '=', stored.id).execute());
    expect(left).toEqual([]);

    browser.csrfToken = fragmentCsrf(location);
    const pendingCookie = browser.session;
    ctx.clock.advance(30_000);
    const verify = await browser.post('/api/v1/auth/mfa/verify', { code: codeAt(user.secret!, ctx.clock) });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json().status).toBe('ok');
    expect(browser.session).not.toBe(pendingCookie);
    const active = await sessionRow(db, browser.session!);
    expect(active).toMatchObject({ state: 'active', auth_method: 'oidc', identity_provider_id: providerA, auth_org_id: orgA.id, organization_id: orgA.id });

    const me = await browser.get('/api/v1/me');
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({ user: { id: user.id }, org: { slug: 'ssoa' }, session: { authMethod: 'oidc' } });
    const logins = await auditOf(user.id, 'auth.login');
    expect(logins.at(-1)?.after).toMatchObject({ method: 'oidc', identityProviderId: providerA, secondFactor: 'totp' });
    expect(logins.at(-1)?.organization_id).toBe(orgA.id);
    const identity = (await identities(user.id))[0]!;
    expect(identity.last_login_at).not.toBeNull();
  });

  it('opens an active session at once when the amr claim proves MFA (Keycloak password and OTP)', async () => {
    const user = await addUser('amr.otp', [orgA], { factor: true });
    const kcUser = await keycloakUser({ requiredActions: ['CONFIGURE_TOTP'] });
    // First sign-in at Keycloak sets up the user's OTP credential (CONFIGURE_TOTP); amr is only ["pwd"] then.
    const setupUrl = new URL(`${kc.issuer}/protocol/openid-connect/auth`);
    setupUrl.search = new URLSearchParams({ client_id: KEYCLOAK_CLIENT_ID, redirect_uri: `${APP_ORIGIN}/setup`, response_type: 'code', scope: 'openid', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' }).toString();
    await signInAtKeycloak(new KeycloakBrowser(), setupUrl.href, kcUser.login);
    expect(kcUser.login.totp?.secret).toBeTruthy();
    await preRegister(providerA, kcUser.sub, user.id);

    const browser = new Browser(ctx.app);
    const { location } = await ssoSignIn(browser, 'kc-a', kcUser.login, { returnTo: '/overview' });
    expect(location).toBe('/overview');
    const session = await sessionRow(db, browser.session!);
    expect(session.state).toBe('active');
    expect([...session.amr].sort()).toEqual(['otp', 'pwd']);
    expect(session.mfa_at).toBeNull();
    const login = (await auditOf(user.id, 'auth.login')).at(-1);
    expect(login?.after).toMatchObject({ method: 'oidc', identityProviderId: providerA, provider: 'kc-a', subject: kcUser.sub, secondFactor: 'idp_mfa' });
  });

  it('refuses a sign-in without MFA proof when the provider rejects it (mfa_required_by_policy)', async () => {
    const strict = await addProvider(orgA.id, 'kc-strict', { mfa_fallback: 'reject' });
    const user = await addUser('amr.strict', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    await preRegister(strict, kcUser.sub, user.id);
    const browser = new Browser(ctx.app);
    const { location } = await ssoSignIn(browser, 'kc-strict', kcUser.login);
    expect(location).toBe('/login?error=mfa_required_by_policy');
    expect(browser.session).toBeUndefined();
    expect(await openSessions(db, user.id)).toEqual([]);
    expect((await providerFailures(strict)).at(-1)).toMatchObject({ error: 'mfa_required_by_policy', reason: 'mfa_claim_missing' });
  });

  it('treats an amr claim of only otp as no MFA proof and continues with the local TOTP step', async () => {
    // A client of its own whose ID token carries amr ["otp"] (a hardcoded claim instead of Keycloak's amr mapper).
    const clientId = `mscd-amr-otp-${randomBytes(4).toString('hex')}`;
    const clientUuid = await admin.createClient({
      clientId,
      secret: KEYCLOAK_CLIENT_SECRET,
      defaultClientScopes: ['basic', 'profile', 'email'],
      protocolMappers: [
        {
          name: 'amr otp only',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-hardcoded-claim-mapper',
          consentRequired: false,
          config: { 'claim.name': 'amr', 'claim.value': '["otp"]', 'jsonType.label': 'JSON', 'id.token.claim': 'true', 'access.token.claim': 'true', 'userinfo.token.claim': 'true' },
        },
      ],
    });
    try {
      const otpOnly = await addProvider(orgA.id, 'kc-otp-only', { oidc_client_id: clientId });
      const user = await addUser('amr.otponly', [orgA], { factor: true });
      const kcUser = await keycloakUser();
      await preRegister(otpOnly, kcUser.sub, user.id);
      const browser = new Browser(ctx.app);
      const { location } = await ssoSignIn(browser, 'kc-otp-only', kcUser.login);
      expect(location).toMatch(/^\/login\/mfa#csrf=[A-Za-z0-9_-]+$/);
      const pending = await sessionRow(db, browser.session!);
      expect(pending).toMatchObject({ state: 'mfa_pending', auth_method: 'oidc', identity_provider_id: otpOnly, user_id: user.id });
      expect(pending.amr).toEqual(['otp']);
    } finally {
      await admin.deleteClient(clientUuid).catch(() => undefined);
    }
  });

  it('sends a user without a factor to the enrolment step, which ends the sign-in', async () => {
    const user = await addUser('no.factor', [orgA]);
    const kcUser = await keycloakUser();
    await preRegister(providerA, kcUser.sub, user.id);
    const browser = new Browser(ctx.app);
    const { location } = await ssoSignIn(browser, 'kc-a', kcUser.login);
    expect(location).toMatch(/^\/login\/enrol#csrf=/);
    expect((await sessionRow(db, browser.session!)).state).toBe('mfa_enrolment');
    browser.csrfToken = fragmentCsrf(location);
    const started = await browser.post('/api/v1/auth/mfa/enrol/start', {});
    expect(started.statusCode, started.body).toBe(200);
    const confirmed = await browser.post('/api/v1/auth/mfa/enrol/confirm', { code: totpAt(base32Decode(started.json().secret), ctx.clock.now()) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const session = await sessionRow(db, browser.session!);
    expect(session).toMatchObject({ state: 'active', auth_method: 'oidc', auth_org_id: orgA.id, identity_provider_id: providerA });
  });

  // -------------------------------------------------------------------------------------------- unknown accounts

  it('answers no_account for an identity linked to nobody (sso.only)', async () => {
    const browser = new Browser(ctx.app);
    const { location } = await ssoSignIn(browser, 'kc-a', { username: 'sso.only' });
    expect(location).toBe('/login?error=no_account');
    expect(browser.session).toBeUndefined();
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ error: 'no_account', reason: 'no_link' });
    const linked = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.user_identity').select('user_id').where('subject', '=', KEYCLOAK_SUBJECTS['sso.only']).execute(),
    );
    expect(linked).toEqual([]);
  });

  it('never links by email: an account with the same verified email but no link gets no_account, also with JIT', async () => {
    const user = await addUser('same.email', [orgA], { factor: true });
    const kcUser = await keycloakUser({ email: user.email });
    const browser = new Browser(ctx.app);
    expect((await ssoSignIn(browser, 'kc-a', kcUser.login)).location).toBe('/login?error=no_account');

    // JIT under the verified domain of that email does not take over the existing account either.
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.verified_domain').values({ organization_id: orgA.id, domain: 'identity.test', verified_by: 'test' }).onConflict((oc) => oc.doNothing()).execute(),
    );
    const jit = await addProvider(orgA.id, 'kc-jit-taken', { jit_provisioning: true, allowed_email_domains: ['identity.test'] });
    expect((await ssoSignIn(new Browser(ctx.app), 'kc-jit-taken', kcUser.login)).location).toBe('/login?error=no_account');
    expect((await providerFailures(jit)).at(-1)).toMatchObject({ error: 'no_account', reason: 'jit_email_taken' });
    expect(await identities(user.id)).toEqual([]);
    expect(await openSessions(db, user.id)).toEqual([]);
  });

  it('refuses a linked account that is disabled or not a member of the provider organisation', async () => {
    const outsider = await addUser('only.b', [orgB], { factor: true });
    const kcOutsider = await keycloakUser();
    await preRegister(providerA, kcOutsider.sub, outsider.id);
    expect((await ssoSignIn(new Browser(ctx.app), 'kc-a', kcOutsider.login)).location).toBe('/login?error=no_account');
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ reason: 'not_a_member' });

    const disabled = await addUser('disabled.sso', [orgA], { factor: true, status: 'disabled' });
    const kcDisabled = await keycloakUser();
    await preRegister(providerA, kcDisabled.sub, disabled.id);
    expect((await ssoSignIn(new Browser(ctx.app), 'kc-a', kcDisabled.login)).location).toBe('/login?error=no_account');
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ reason: 'account_disabled' });
  });

  // ------------------------------------------------------------------------------------------- transaction checks

  it('refuses a callback whose state matches no transaction, and keeps the real transaction usable', async () => {
    const user = await addUser('state.check', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    await preRegister(providerA, kcUser.sub, user.id);
    const browser = new Browser(ctx.app);
    const startResponse = await start(browser, 'kc-a');
    const binding = browser.cookies.get(BINDING_COOKIE)!;
    const callbackPath = await atKeycloak(startResponse, kcUser.login);
    const forged = new URL(callbackPath, APP_ORIGIN);
    forged.searchParams.set('state', randomBytes(32).toString('base64url'));
    const refused = await browser.get(forged.pathname + forged.search);
    expect(refused.headers.location).toBe('/login?error=expired');
    expect(browser.session).toBeUndefined();

    // The forged state consumed nothing: the browser that started the flow completes it with the real state.
    browser.cookies.set(BINDING_COOKIE, binding);
    const done = await browser.get(callbackPath);
    expect(String(done.headers.location)).toMatch(/^\/login\/mfa#csrf=/);
    expect((await sessionRow(db, browser.session!)).user_id).toBe(user.id);
  });

  it('refuses a replayed callback (the transaction is single use)', async () => {
    const user = await addUser('replay.check', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    await preRegister(providerA, kcUser.sub, user.id);
    const browser = new Browser(ctx.app);
    const startResponse = await start(browser, 'kc-a');
    const binding = browser.cookies.get(BINDING_COOKIE)!;
    const callbackPath = await atKeycloak(startResponse, kcUser.login);
    expect(String((await browser.get(callbackPath)).headers.location)).toMatch(/^\/login\/mfa#csrf=/);
    expect(await openSessions(db, user.id)).toHaveLength(1);

    const replay = new Browser(ctx.app);
    replay.cookies.set(BINDING_COOKIE, binding);
    const second = await replay.get(callbackPath);
    expect(second.headers.location).toBe('/login?error=expired');
    expect(replay.session).toBeUndefined();
    expect(await openSessions(db, user.id)).toHaveLength(1);
  });

  it('refuses an expired transaction', async () => {
    const user = await addUser('expiry.check', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    await preRegister(providerA, kcUser.sub, user.id);
    const browser = new Browser(ctx.app);
    const startResponse = await start(browser, 'kc-a');
    ctx.clock.advance(10 * 60_000 + 1_000);
    const callbackPath = await atKeycloak(startResponse, kcUser.login);
    const done = await browser.get(callbackPath);
    expect(done.headers.location).toBe('/login?error=expired');
    expect(browser.session).toBeUndefined();
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ error: 'expired', reason: 'transaction_expired' });
  });

  it('refuses a callback without the browser binding cookie and consumes the transaction', async () => {
    const user = await addUser('binding.check', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    await preRegister(providerA, kcUser.sub, user.id);
    const browser = new Browser(ctx.app);
    const startResponse = await start(browser, 'kc-a');
    const binding = browser.cookies.get(BINDING_COOKIE)!;
    const callbackPath = await atKeycloak(startResponse, kcUser.login);
    browser.cookies.delete(BINDING_COOKIE);
    expect((await browser.get(callbackPath)).headers.location).toBe('/login?error=expired');
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ reason: 'binding_mismatch' });

    // A wrong binding value fails the same way, and the right one comes too late: the transaction is gone.
    browser.cookies.set(BINDING_COOKIE, binding);
    expect((await browser.get(callbackPath)).headers.location).toBe('/login?error=expired');
    expect(browser.session).toBeUndefined();
    expect(await openSessions(db, user.id)).toEqual([]);
  });

  it('maps an error answer of the provider to idp_error', async () => {
    const browser = new Browser(ctx.app);
    const startResponse = await start(browser, 'kc-a');
    const state = new URL(String(startResponse.headers.location)).searchParams.get('state')!;
    const done = await browser.get(`/api/v1/auth/oidc/kc-a/callback?state=${encodeURIComponent(state)}&error=access_denied`);
    expect(done.headers.location).toBe('/login?error=idp_error');
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ error: 'idp_error', reason: 'provider_error:access_denied' });
  });

  it('answers 404 for unknown and disabled providers and refuses absolute return paths', async () => {
    const browser = new Browser(ctx.app);
    expect((await start(browser, 'no-such-idp')).statusCode).toBe(404);
    const disabled = await addProvider(orgA.id, 'kc-off', { enabled: false });
    expect((await start(browser, 'kc-off')).statusCode).toBe(404);
    expect((await start(browser, 'kc-a', { returnTo: 'https://evil.example/' })).statusCode).toBe(400);
    expect((await start(browser, 'kc-a', { returnTo: '//evil.example/' })).statusCode).toBe(400);

    // A provider disabled between start and callback fails the callback.
    await updateProvider(disabled, { enabled: true });
    const user = await addUser('off.later', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    await preRegister(disabled, kcUser.sub, user.id);
    const startResponse = await start(browser, 'kc-off');
    const callbackPath = await atKeycloak(startResponse, kcUser.login);
    await updateProvider(disabled, { enabled: false });
    expect((await browser.get(callbackPath)).headers.location).toBe('/login?error=idp_error');
    expect(await openSessions(db, user.id)).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------------- invitations

  it('redeems an invitation through a provider of the inviting organisation, once only', async () => {
    const kcUser = await keycloakUser();
    const invited = await ctx.moduleRef
      .get(TenantScope)
      .withPlatform((trx) => ctx.moduleRef.get(InvitationService).inviteUser(trx, { orgId: orgA.id, email: kcUser.email, actor: { userId: null, kind: 'operator' } }), {
        scope: 'cli',
      });
    const token = invited.invitation!.token;
    const checksBefore = ctx.licence.userChecks.length;
    const browser = new Browser(ctx.app);
    const invitationStart = await start(new Browser(ctx.app), 'kc-a', { invitation: token });
    expect(new URL(String(invitationStart.headers.location)).searchParams.get('prompt')).toBe('login');
    const { location } = await ssoSignIn(browser, 'kc-a', kcUser.login, { invitation: token });
    expect(location).toMatch(/^\/login\/enrol#csrf=/);
    const session = await sessionRow(db, browser.session!);
    expect(session).toMatchObject({ state: 'mfa_enrolment', user_id: invited.userId, auth_org_id: orgA.id, organization_id: orgA.id, auth_method: 'oidc' });
    const [identity] = await identities(invited.userId);
    expect(identity).toMatchObject({ identity_provider_id: providerA, subject: kcUser.sub, link_method: 'invitation', email_at_link: kcUser.email });
    const state = await inScope(db.migrator, { platformScope: true }, async (trx) => ({
      user: await trx.selectFrom('platform.app_user').select('status').where('id', '=', invited.userId).executeTakeFirstOrThrow(),
      membership: await trx.selectFrom('platform.org_membership').select(['status', 'accepted_at']).where('user_id', '=', invited.userId).where('organization_id', '=', orgA.id).executeTakeFirstOrThrow(),
      invitation: await trx.selectFrom('platform.invitation').select('used_at').where('id', '=', invited.invitation!.invitationId).executeTakeFirstOrThrow(),
    }));
    expect(state.user.status).toBe('active');
    expect(state.membership.status).toBe('active');
    expect(state.membership.accepted_at).not.toBeNull();
    expect(state.invitation.used_at).not.toBeNull();
    // The membership became active: the licence user limit was checked again (D-15).
    expect(ctx.licence.userChecks.slice(checksBefore)).toEqual([orgA.id]);
    expect((await auditOf(invited.userId, 'identity.linked')).at(-1)?.after).toMatchObject({ linkMethod: 'invitation', provider: 'kc-a', subject: kcUser.sub });

    // The link works once: a second start with the same token goes back to the login page.
    const second = await start(new Browser(ctx.app), 'kc-a', { invitation: token });
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toBe('/login?error=invitation_invalid');
  });

  it('refuses an invitation of another organisation or for another email', async () => {
    const platform = ctx.moduleRef.get(TenantScope);
    const invitations = ctx.moduleRef.get(InvitationService);
    const kcUser = await keycloakUser();
    const forB = await platform.withPlatform((trx) => invitations.inviteUser(trx, { orgId: orgB.id, email: kcUser.email, actor: { userId: null, kind: 'operator' } }), { scope: 'cli' });
    // A provider of organisation A cannot redeem an invitation of organisation B.
    const viaA = await start(new Browser(ctx.app), 'kc-a', { invitation: forB.invitation!.token });
    expect(viaA.headers.location).toBe('/login?error=invitation_invalid');

    const other = await keycloakUser();
    const forOther = await platform.withPlatform(
      (trx) => invitations.inviteUser(trx, { orgId: orgA.id, email: `invitee-${randomBytes(3).toString('hex')}@keycloak.test`, actor: { userId: null, kind: 'operator' } }),
      { scope: 'cli' },
    );
    const browser = new Browser(ctx.app);
    const { location } = await ssoSignIn(browser, 'kc-a', other.login, { invitation: forOther.invitation!.token });
    expect(location).toBe('/login?error=invitation_invalid');
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ reason: 'invitation_email_mismatch' });
    const unused = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.invitation').select('used_at').where('id', '=', forOther.invitation!.invitationId).executeTakeFirstOrThrow(),
    );
    expect(unused.used_at).toBeNull();
    expect(await identities(forOther.userId)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------------- linking

  it('links an identity from a local session with a recent second factor', async () => {
    const user = await addUser('link.me', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    const browser = await signIn(ctx, user);
    await mail.clear();
    const link = await browser.post('/api/v1/me/identities/kc-a/link');
    expect(link.statusCode, link.body).toBe(200);
    const redirectUrl = link.json().redirectUrl as string;
    expect(redirectUrl.startsWith(`${kc.issuer}/protocol/openid-connect/auth?`)).toBe(true);
    // Linking makes the person sign in at the provider now, whatever provider session the browser has.
    expect(new URL(redirectUrl).searchParams.get('prompt')).toBe('login');
    expect(String(link.headers['set-cookie'])).toContain(`${BINDING_COOKIE}=`);
    const transaction = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.auth_transaction').selectAll().where('state_hash', '=', sha256(new URL(redirectUrl).searchParams.get('state')!)).executeTakeFirstOrThrow(),
    );
    expect(transaction).toMatchObject({ kind: 'oidc_link', user_id: user.id, identity_provider_id: providerA });
    const sessionBefore = browser.session;

    const callbackPath = appPath(await signInAtKeycloak(new KeycloakBrowser(), redirectUrl, kcUser.login));
    const done = await browser.get(callbackPath);
    expect(done.headers.location).toBe('/');
    expect(browser.session).toBe(sessionBefore);
    const [identity] = await identities(user.id);
    expect(identity).toMatchObject({ identity_provider_id: providerA, subject: kcUser.sub, link_method: 'session', linked_by: user.id });
    expect((await auditOf(user.id, 'identity.linked')).at(-1)?.after).toMatchObject({ linkMethod: 'session', provider: 'kc-a', subject: kcUser.sub });
    const email = await mail.waitFor(user.email, (m) => m.mailKind === 'security:identity_linked');
    expect(email.text).toContain('Sign in with kc-a');

    // The linked identity now signs the user in.
    const sso = new Browser(ctx.app);
    const { location } = await ssoSignIn(sso, 'kc-a', kcUser.login);
    expect(location).toMatch(/^\/login\/mfa#csrf=/);
    expect((await sessionRow(db, sso.session!)).user_id).toBe(user.id);
  });

  it('refuses linking without a recent proof, from another browser, and for a subject linked to someone else', async () => {
    const user = await addUser('link.late', [orgA], { factor: true });
    const browser = await signIn(ctx, user);
    ctx.clock.advance(6 * 60_000);
    const late = await browser.post('/api/v1/me/identities/kc-a/link');
    expect(late.statusCode).toBe(401);
    expect(late.json().messageKey).toBe('auth.proof_required');
    expect((await browser.post('/api/v1/me/identities/no-such-idp/link')).statusCode).toBe(404);
    // A provider of an organisation the user is not a member of is unknown to the user.
    expect((await browser.post('/api/v1/me/identities/kc-b/link')).statusCode).toBe(404);

    // The callback of a link must come back to the browser of the signed-in user.
    const fresh = await signIn(ctx, user);
    const kcUser = await keycloakUser();
    const link = await fresh.post('/api/v1/me/identities/kc-a/link');
    expect(link.statusCode).toBe(200);
    const callbackPath = appPath(await signInAtKeycloak(new KeycloakBrowser(), link.json().redirectUrl, kcUser.login));
    const stranger = new Browser(ctx.app);
    stranger.cookies.set(BINDING_COOKIE, fresh.cookies.get(BINDING_COOKIE)!);
    expect((await stranger.get(callbackPath)).headers.location).toBe('/login?error=expired');
    expect(await identities(user.id)).toEqual([]);

    // A subject already linked to another account is not moved.
    const owner = await addUser('link.owner', [orgA], { factor: true });
    const taken = await keycloakUser();
    await preRegister(providerA, taken.sub, owner.id);
    const again = await signIn(ctx, user);
    const second = await again.post('/api/v1/me/identities/kc-a/link');
    const path = appPath(await signInAtKeycloak(new KeycloakBrowser(), second.json().redirectUrl, taken.login));
    expect((await again.get(path)).headers.location).toBe('/login?error=idp_error');
    expect((await identities(owner.id)).map((i) => i.subject)).toEqual([taken.sub]);
    expect(await identities(user.id)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------------- JIT

  it('provisions a new account just in time only under verified domains of the provider organisation', async () => {
    const domain = `jit-${randomBytes(3).toString('hex')}.mscd.test`;
    const jit = await addProvider(orgA.id, `kc-jit-${randomBytes(2).toString('hex')}`, { jit_provisioning: true, allowed_email_domains: [domain] });
    const slug = (await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.identity_provider').select('slug').where('id', '=', jit).executeTakeFirstOrThrow())).slug;
    const kcUser = await keycloakUser({ email: `new.person@${domain}` });

    // The domain is not verified yet: no account.
    expect((await ssoSignIn(new Browser(ctx.app), slug, kcUser.login)).location).toBe('/login?error=no_account');
    expect((await providerFailures(jit)).at(-1)).toMatchObject({ reason: 'jit_domain_unverified' });

    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.verified_domain').values({ organization_id: orgA.id, domain, verified_by: 'test' }).execute(),
    );
    // An unverified email of that domain does not qualify.
    const unverified = await keycloakUser({ email: `unverified@${domain}`, emailVerified: false });
    expect((await ssoSignIn(new Browser(ctx.app), slug, unverified.login)).location).toBe('/login?error=no_account');
    expect((await providerFailures(jit)).at(-1)).toMatchObject({ reason: 'jit_email_unverified' });

    // The licence user limit stops JIT.
    ctx.licence.userLimitReached = true;
    expect((await ssoSignIn(new Browser(ctx.app), slug, kcUser.login)).location).toBe('/login?error=no_account');
    expect((await providerFailures(jit)).at(-1)).toMatchObject({ reason: 'jit_licence_user_limit' });
    ctx.licence.userLimitReached = false;

    const browser = new Browser(ctx.app);
    const { location } = await ssoSignIn(browser, slug, kcUser.login);
    expect(location).toMatch(/^\/login\/enrol#csrf=/);
    const created = await inScope(db.migrator, { platformScope: true }, async (trx) => {
      const user = await trx.selectFrom('platform.app_user').selectAll().where('email', '=', kcUser.email).executeTakeFirstOrThrow();
      const memberships = await trx.selectFrom('platform.org_membership').selectAll().where('user_id', '=', user.id).execute();
      return { user, memberships };
    });
    expect(created.user).toMatchObject({ status: 'active', kind: 'person', handle: 'new.person', mfa_required: true, password_hash: null });
    expect(created.memberships).toEqual([expect.objectContaining({ organization_id: orgA.id, status: 'active', admin_roles: [] })]);
    expect(await identities(created.user.id)).toEqual([expect.objectContaining({ identity_provider_id: jit, subject: kcUser.sub, link_method: 'jit' })]);
    expect((await sessionRow(db, browser.session!)).auth_org_id).toBe(orgA.id);
    expect((await auditOf(created.user.id, 'user.created')).at(-1)?.after).toMatchObject({ via: 'jit' });
  });

  it('does not provision accounts when JIT is off', async () => {
    const domain = `nojit-${randomBytes(3).toString('hex')}.mscd.test`;
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.verified_domain').values({ organization_id: orgA.id, domain, verified_by: 'test' }).execute(),
    );
    const kcUser = await keycloakUser({ email: `someone@${domain}` });
    expect((await ssoSignIn(new Browser(ctx.app), 'kc-a', kcUser.login)).location).toBe('/login?error=no_account');
    const users = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.app_user').select('id').where('email', '=', kcUser.email).execute());
    expect(users).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------ organisation pin

  it('pins the session to the provider organisation; a switch to another organisation needs a new sign-in', async () => {
    const user = await addUser('two.orgs', [orgB, orgA], { factor: true });
    const kcUser = await keycloakUser();
    await preRegister(providerA, kcUser.sub, user.id);
    const browser = new Browser(ctx.app);
    const { location } = await ssoSignIn(browser, 'kc-a', kcUser.login);
    browser.csrfToken = fragmentCsrf(location);
    ctx.clock.advance(30_000);
    expect((await browser.post('/api/v1/auth/mfa/verify', { code: codeAt(user.secret!, ctx.clock) })).statusCode).toBe(200);
    // The user's default organisation is B, but the provider of A authenticated the session.
    const session = await sessionRow(db, browser.session!);
    expect(session).toMatchObject({ organization_id: orgA.id, auth_org_id: orgA.id });

    // The identity of A's provider is unknown to B's provider: no session for B through it.
    expect((await ssoSignIn(new Browser(ctx.app), 'kc-b', kcUser.login)).location).toBe('/login?error=no_account');
    expect((await providerFailures(providerB)).at(-1)).toMatchObject({ error: 'no_account', reason: 'no_link' });

    const switched = await browser.put('/api/v1/me/org', { org: 'ssob' });
    expect(switched.statusCode, switched.body).toBe(409);
    expect(switched.json()).toMatchObject({ type: expect.stringContaining('reauth-required'), methods: { providers: expect.arrayContaining([expect.objectContaining({ slug: 'kc-b' })]) } });
    expect((await sessionRow(db, browser.session!)).organization_id).toBe(orgA.id);
    const me = await browser.get('/api/v1/me');
    expect(me.json()).toMatchObject({ org: { slug: 'ssoa' }, session: { authMethod: 'oidc' } });
  });

  it('revokes the sessions of a provider when it is disabled (F.1)', async () => {
    const user = await addUser('idp.revoked', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    const revoking = await addProvider(orgA.id, `kc-rev-${randomBytes(2).toString('hex')}`);
    await preRegister(revoking, kcUser.sub, user.id);
    const slug = (await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.identity_provider').select('slug').where('id', '=', revoking).executeTakeFirstOrThrow())).slug;
    const browser = new Browser(ctx.app);
    await ssoSignIn(browser, slug, kcUser.login);
    expect(await openSessions(db, user.id)).toHaveLength(1);
    await ctx.moduleRef.get(TenantScope).withPlatform((trx) => ctx.moduleRef.get(SessionService).revokeProviderSessions(trx, revoking), { scope: 'operator' });
    expect(await openSessions(db, user.id)).toEqual([]);
  });

  it('keeps the second-factor checks of the local TOTP step for SSO sessions', async () => {
    const user = await addUser('totp.wrong', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    await preRegister(providerA, kcUser.sub, user.id);
    const browser = new Browser(ctx.app);
    const { location } = await ssoSignIn(browser, 'kc-a', kcUser.login);
    browser.csrfToken = fragmentCsrf(location);
    const right = codeAt(user.secret!, ctx.clock, 3);
    const wrong = String((Number(right) + 500_000) % 1_000_000).padStart(6, '0');
    expect((await browser.post('/api/v1/auth/mfa/verify', { code: wrong })).statusCode).toBe(401);
    expect((await sessionRow(db, browser.session!)).state).toBe('mfa_pending');
    // The CSRF token of the pending session is required.
    expect((await browser.post('/api/v1/auth/mfa/verify', { code: codeAt(user.secret!, ctx.clock) }, { csrf: false })).statusCode).toBe(403);
    // Neither an SSO session in mfa_pending nor a pending cookie reaches business routes.
    expect((await browser.post('/api/v1/me/identities/kc-a/link')).statusCode).toBe(401);
  });
});