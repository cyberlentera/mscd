// SAML sign-in against Keycloak (build plan F.9, F.8 step 4, F.5, D-25, D-26, WP-19). Runs with MSCD_TEST_SSO=1,
// which starts keycloak/keycloak:26.7.5 with the realm of the developer stack once per run (test/setup/keycloak.ts);
// the realm's SAML client `mscd-dev-sp` signs responses and assertions and sends a persistent NameID. Each test
// drives the browser flow: the api's start route (light-my-request with a cookie jar), the Keycloak sign-in pages
// (real HTTP with a cookie jar) up to the auto-posted SAML form, then the api's ACS with that form, as the browser
// would post it from the identity provider's page.
import { randomBytes, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
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
import {
  assertionFacts,
  checkSubjectConfirmation,
  decideSamlMfa,
  PERSISTENT_NAMEID_FORMAT,
  replayCacheExpiry,
  responseInResponseTo,
  samlSubjectOf,
} from '../../../src/modules/identity/saml/saml-rules';
import { SamlModule } from '../../../src/modules/identity/saml/saml.module';
import { sha256 } from '../../../src/modules/identity/tokens';
import { KeysModule } from '../../../src/modules/keys/keys.module';
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
  type IdentityApp,
  type TestUser,
  addUser as addLocalUser,
} from '../identity/helpers';
import { createTenant } from '../../setup/global-db';
import { KeycloakAdmin, KeycloakBrowser, keycloakSignIn, type KeycloakSignIn } from '../../setup/keycloak';
import { useTestDatabase, type TestDatabase } from '../../setup/test-db';

const keycloak = inject('mscdKeycloak');
const BINDING_COOKIE = 'mscd_saml_tx';
const SP_ENTITY_ID = 'mscd-dev-sp';

// ---------------------------------------------------------------------------------------------------------------
// Rules without Keycloak (F.9, F.5)
// ---------------------------------------------------------------------------------------------------------------

describe('SAML rules', () => {
  const now = new Date('2026-10-01T08:00:00.000Z');
  const later = new Date(now.getTime() + 5 * 60_000);

  function parsedAssertion(overrides: { format?: string; nameId?: string; inResponseTo?: string; recipient?: string; method?: string; notOnOrAfter?: string; id?: string } = {}) {
    const nameId = { _: overrides.nameId ?? 'G-1234', $: { Format: overrides.format ?? PERSISTENT_NAMEID_FORMAT } };
    return {
      Assertion: {
        $: { ID: overrides.id ?? 'ID_abc' },
        Issuer: [{ _: 'http://idp.example/realms/mscd' }],
        Subject: [
          {
            NameID: [nameId],
            SubjectConfirmation: [
              {
                $: { Method: overrides.method ?? 'urn:oasis:names:tc:SAML:2.0:cm:bearer' },
                SubjectConfirmationData: [
                  { $: { InResponseTo: overrides.inResponseTo ?? '_req1', Recipient: overrides.recipient ?? 'https://sp.example/acs', NotOnOrAfter: overrides.notOnOrAfter ?? later.toISOString() } },
                ],
              },
            ],
          },
        ],
        Conditions: [{ $: { NotOnOrAfter: later.toISOString() } }],
        AuthnStatement: [{ AuthnContext: [{ AuthnContextClassRef: [{ _: 'https://refeds.org/profile/mfa' }] }] }],
        AttributeStatement: [{ Attribute: [{ $: { Name: 'email' }, AttributeValue: [{ _: 'rina@example.co.id' }] }] }],
      },
    };
  }

  it('reads the facts of an assertion and accepts only the persistent NameID', () => {
    const facts = assertionFacts(parsedAssertion());
    expect(facts).toMatchObject({ id: 'ID_abc', issuer: 'http://idp.example/realms/mscd', nameId: 'G-1234', authnContextClassRefs: ['https://refeds.org/profile/mfa'], email: 'rina@example.co.id' });
    expect(samlSubjectOf(facts)).toBe('G-1234');
    expect(() => samlSubjectOf(assertionFacts(parsedAssertion({ format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' })))).toThrow(/idp_error: nameid_not_persistent/);
    expect(() => samlSubjectOf(assertionFacts(parsedAssertion({ nameId: 'x'.repeat(256) })))).toThrow(/idp_error/);
    expect(() => assertionFacts({ Assertion: { Subject: [] } })).toThrow(/assertion_id_missing/);
  });

  it('checks InResponseTo, Recipient and validity of the bearer confirmation', () => {
    const expected = { requestId: '_req1', acsUrl: 'https://sp.example/acs', responseInResponseTo: '_req1', now };
    expect(() => checkSubjectConfirmation(assertionFacts(parsedAssertion()), expected)).not.toThrow();
    expect(() => checkSubjectConfirmation(assertionFacts(parsedAssertion()), { ...expected, responseInResponseTo: null })).not.toThrow();
    expect(() => checkSubjectConfirmation(assertionFacts(parsedAssertion({ inResponseTo: '_other' })), expected)).toThrow(/expired: in_response_to_mismatch/);
    expect(() => checkSubjectConfirmation(assertionFacts(parsedAssertion()), { ...expected, responseInResponseTo: '_other' })).toThrow(/in_response_to_mismatch/);
    expect(() => checkSubjectConfirmation(assertionFacts(parsedAssertion({ recipient: 'https://evil.example/acs' })), expected)).toThrow(/recipient_mismatch/);
    expect(() => checkSubjectConfirmation(assertionFacts(parsedAssertion({ method: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key' })), expected)).toThrow(/bearer_confirmation_missing/);
    const expired = new Date(now.getTime() - 61_000).toISOString();
    expect(() => checkSubjectConfirmation(assertionFacts(parsedAssertion({ notOnOrAfter: expired })), expected)).toThrow(/confirmation_expired/);
    // Within the 60 second skew.
    const justExpired = new Date(now.getTime() - 30_000).toISOString();
    expect(() => checkSubjectConfirmation(assertionFacts(parsedAssertion({ notOnOrAfter: justExpired })), expected)).not.toThrow();
  });

  it('keeps an assertion id until its latest NotOnOrAfter plus the skew', () => {
    expect(replayCacheExpiry(assertionFacts(parsedAssertion())).getTime()).toBe(later.getTime() + 60_000);
    expect(() => replayCacheExpiry({ notOnOrAfter: null, confirmations: [] })).toThrow(/assertion_validity_missing/);
  });

  it('decides the second factor from AuthnContextClassRef and the provider policy', () => {
    const base = { require_mfa_claim: true, saml_mfa_authn_contexts: ['https://refeds.org/profile/mfa'], mfa_fallback: 'local_totp' as const };
    expect(decideSamlMfa(['https://refeds.org/profile/mfa'], base)).toEqual({ kind: 'idp' });
    expect(decideSamlMfa(['urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'], base)).toEqual({ kind: 'local_totp' });
    expect(decideSamlMfa([], { ...base, mfa_fallback: 'reject' })).toEqual({ kind: 'reject' });
    expect(decideSamlMfa(['https://refeds.org/profile/mfa'], { ...base, require_mfa_claim: false })).toEqual({ kind: 'local_totp' });
  });

  it('reads InResponseTo of the outer response', () => {
    expect(responseInResponseTo('<?xml version="1.0"?><samlp:Response xmlns:samlp="x" ID="r" InResponseTo="_abc"><x/></samlp:Response>')).toBe('_abc');
    expect(responseInResponseTo("<Response InResponseTo='_q'/>")).toBe('_q');
    expect(responseInResponseTo('<samlp:Response ID="r"></samlp:Response>')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Application and fixtures
// ---------------------------------------------------------------------------------------------------------------

async function createSamlApp(db: TestDatabase, extraEnv: Record<string, string> = {}): Promise<IdentityApp> {
  // No mail server: the mailer logs failures and never blocks a flow.
  const env: Record<string, string> = { MSCD__MAIL__SMTP__PORT: '9', ...extraEnv };
  const config = db.config(env);
  const clock = mutableClock(config, new Date());
  const licence = new FakeLicenceGate();

  @Global()
  @Module({ providers: [{ provide: LICENCE_GATE, useValue: licence }], exports: [LICENCE_GATE] })
  class FakeLicenceModule {}

  // AdminIdpModule loads OidcModule (and with it the identity link route), as the api does; SamlModule next to it.
  const moduleRef: TestingModule = await db
    .createTestingModule({ imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, AdminIdpModule, SamlModule, FakeLicenceModule] }, env)
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

/** The signing certificates of the realm's SAML descriptor, as PEM. */
async function realmCertificates(issuer: string): Promise<string[]> {
  const response = await fetch(`${issuer}/protocol/saml/descriptor`);
  expect(response.status).toBe(200);
  const xml = await response.text();
  const certs = [...xml.matchAll(/<(?:ds:)?X509Certificate>([^<]+)<\/(?:ds:)?X509Certificate>/g)].map((m) => m[1]!.replace(/\s+/g, ''));
  expect(certs.length).toBeGreaterThan(0);
  return [...new Set(certs)].map((b64) => `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`);
}

/** The XML of a posted `SAMLResponse`. */
function responseXml(fields: Record<string, string>): string {
  return Buffer.from(fields.SAMLResponse!, 'base64').toString('utf8');
}

function nameIdOf(fields: Record<string, string>): string {
  const match = /<(?:saml2?:)?NameID\b[^>]*>([^<]+)<\/(?:saml2?:)?NameID>/.exec(responseXml(fields));
  if (!match) throw new Error('No NameID in the SAML response');
  return match[1]!;
}

function assertionIdOf(fields: Record<string, string>): string {
  const match = /<(?:saml2?:)?Assertion\b[^>]*\sID="([^"]+)"/.exec(responseXml(fields));
  if (!match) throw new Error('No assertion in the SAML response');
  return match[1]!;
}

function authnContextOf(fields: Record<string, string>): string {
  const match = /<(?:saml2?:)?AuthnContextClassRef>([^<]+)</.exec(responseXml(fields));
  if (!match) throw new Error('No AuthnContextClassRef in the SAML response');
  return match[1]!;
}

/** The decoded AuthnRequest of an HTTP-Redirect URL. */
function authnRequestOf(url: string): string {
  const encoded = new URL(url).searchParams.get('SAMLRequest');
  if (!encoded) throw new Error(`No SAMLRequest in ${url}`);
  return inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
}

/** The CSRF token handed over in the fragment of `/login/mfa#csrf=` or `/login/enrol#csrf=`. */
function fragmentCsrf(location: string): string {
  const match = /#csrf=([A-Za-z0-9_-]+)$/.exec(location);
  if (!match) throw new Error(`No CSRF token in ${location}`);
  return match[1]!;
}

const describeSso = describe.skipIf(!keycloak);

describeSso('SAML sign-in with Keycloak', () => {
  const db = useTestDatabase('empty');
  const kc = keycloak!;
  const admin = new KeycloakAdmin(kc);
  let ctx: IdentityApp;
  let orgA: CreatedTenant;
  let orgB: CreatedTenant;
  let certs: string[];
  let providerA: string;
  let providerB: string;
  const keycloakUsers: string[] = [];

  beforeAll(async () => {
    orgA = await createTenant(db, 'samla');
    orgB = await createTenant(db, 'samlb');
    ctx = await createSamlApp(db);
    certs = await realmCertificates(kc.issuer);
    providerA = await addProvider(orgA.id, 'saml-a');
    providerB = await addProvider(orgB.id, 'saml-b');
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.identity_provider').values({ organization_id: orgA.id, slug: 'oidc-only', kind: 'oidc', display_name: 'OIDC', oidc_issuer: kc.issuer, oidc_client_id: 'mscd' }).execute(),
    );
  });

  afterAll(async () => {
    await ctx?.close();
    for (const id of keycloakUsers) await admin.deleteUser(id).catch(() => undefined);
  });

  beforeEach(async () => {
    await resetRateLimits(db);
  });

  // ------------------------------------------------------------------------------------------------- fixtures

  async function addProvider(orgId: string, slug: string, values: Partial<Insertable<IdentityProviderTable>> = {}): Promise<string> {
    const id = randomUUID();
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx
        .insertInto('platform.identity_provider')
        .values({
          id,
          organization_id: orgId,
          slug,
          kind: 'saml',
          display_name: `Sign in with ${slug}`,
          icon: 'generic',
          saml_entry_point: `${kc.issuer}/protocol/saml`,
          saml_idp_issuer: kc.issuer,
          saml_idp_certs: certs,
          saml_sp_entity_id: SP_ENTITY_ID,
          ...values,
        })
        .execute(),
    );
    return id;
  }

  async function updateProvider(id: string, values: Partial<Insertable<IdentityProviderTable>>): Promise<void> {
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.identity_provider').set(values).where('id', '=', id).execute());
  }

  /** A Keycloak user with a unique name. Keycloak gives it a persistent NameID (`G-<uuid>`) at its first SAML sign-in. */
  async function keycloakUser(): Promise<{ login: KeycloakSignIn; email: string }> {
    const username = `kcs-${randomBytes(5).toString('hex')}`;
    const email = `${username}@keycloak.test`;
    keycloakUsers.push(await admin.createUser({ username, email }));
    return { email, login: { username, totp: { secret: null } } };
  }

  function addUser(handle: string, orgs: CreatedTenant[], options: { factor?: boolean } = {}): Promise<TestUser> {
    return addLocalUser(db, ctx.moduleRef, { handle, memberships: orgs.map((org) => ({ org })), factor: options.factor ?? false });
  }

  async function preRegister(providerId: string, subject: string, userId: string): Promise<void> {
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.user_identity').values({ identity_provider_id: providerId, subject, user_id: userId, link_method: 'admin' }).execute(),
    );
  }

  async function identities(userId: string) {
    return inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.user_identity').selectAll().where('user_id', '=', userId).execute());
  }

  async function transactionOf(relayState: string) {
    return inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.auth_transaction').selectAll().where('state_hash', '=', sha256(relayState)).executeTakeFirst());
  }

  /** `GET /auth/saml/{slug}/start`; returns the response (302 to Keycloak, or to the login page). */
  function start(browser: Browser, slug: string, query: Record<string, string> = {}) {
    const search = new URLSearchParams(query).toString();
    return browser.get(`/api/v1/auth/saml/${slug}/start${search ? `?${search}` : ''}`);
  }

  /** The HTTP-Redirect URL of a start response. */
  function redirectOf(startResponse: { statusCode: number; headers: Record<string, unknown> }): string {
    expect(startResponse.statusCode).toBe(302);
    const location = String(startResponse.headers.location);
    expect(location.startsWith(`${kc.issuer}/protocol/saml?`), location).toBe(true);
    return location;
  }

  /** Signs in at Keycloak and returns the fields of the form Keycloak auto-posts to the ACS of `slug`. */
  async function atKeycloak(redirectUrl: string, login: KeycloakSignIn, slug: string, kcBrowser = new KeycloakBrowser()): Promise<Record<string, string>> {
    const outcome = await keycloakSignIn(kcBrowser, redirectUrl, login);
    if (outcome.kind !== 'post') throw new Error(`Keycloak redirected to ${outcome.url} instead of posting a SAML response`);
    expect(outcome.action).toBe(`${APP_ORIGIN}/api/v1/auth/saml/${slug}/acs`);
    expect(outcome.fields.SAMLResponse).toBeTruthy();
    return outcome.fields;
  }

  /** The browser posts the identity provider's form to the ACS (cross-site: no CSRF header, Keycloak's origin). */
  function postAcs(browser: Browser, slug: string, fields: Record<string, string>) {
    return browser.post(`/api/v1/auth/saml/${slug}/acs`, new URLSearchParams(fields).toString(), {
      csrf: false,
      origin: kc.baseUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  }

  /** The full flow for a user whose NameID is pre-registered for `userId` once Keycloak has assigned it. */
  async function samlSignIn(
    browser: Browser,
    slug: string,
    providerId: string,
    login: KeycloakSignIn,
    options: { userId?: string; query?: Record<string, string> } = {},
  ): Promise<{ location: string; fields: Record<string, string>; nameId: string }> {
    const fields = await atKeycloak(redirectOf(await start(browser, slug, options.query)), login, slug);
    const nameId = nameIdOf(fields);
    if (options.userId) await preRegister(providerId, nameId, options.userId);
    const done = await postAcs(browser, slug, fields);
    expect(done.statusCode, done.body).toBe(302);
    return { location: String(done.headers.location), fields, nameId };
  }

  async function auditOf(userId: string, action: string) {
    return (await auditActions(db, userId)).filter((a) => a.action === action);
  }

  async function providerFailures(providerId: string): Promise<{ method: string; error: string; reason: string }[]> {
    const rows = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').select('after_data').where('action', '=', 'auth.login_failed').where('entity_id', '=', providerId).orderBy('seq').execute(),
    );
    return rows.map((r) => r.after_data as unknown as { method: string; error: string; reason: string });
  }

  /** Changes attributes of the realm's SAML client for one test and restores them afterwards. */
  async function withClientAttributes<T>(attributes: Record<string, string>, run: () => Promise<T>): Promise<T> {
    const before = (await admin.updateClient(SP_ENTITY_ID, { attributes })) as { attributes?: Record<string, string> };
    const restore = Object.fromEntries(Object.keys(attributes).map((k) => [k, before.attributes?.[k] ?? '']));
    try {
      return await run();
    } finally {
      await admin.updateClient(SP_ENTITY_ID, { attributes: restore });
    }
  }

  // ------------------------------------------------------------------------------------------------- metadata

  it('serves the SP metadata of a SAML provider and 404 for others', async () => {
    const browser = new Browser(ctx.app);
    const response = await browser.get('/api/v1/auth/saml/saml-a/metadata');
    expect(response.statusCode, response.body).toBe(200);
    expect(String(response.headers['content-type'])).toContain('application/samlmetadata+xml');
    const xml = response.body;
    expect(xml).toContain(`entityID="${SP_ENTITY_ID}"`);
    expect(xml).toMatch(/AssertionConsumerService[^>]*Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"/);
    expect(xml).toContain(`Location="${APP_ORIGIN}/api/v1/auth/saml/saml-a/acs"`);
    expect(xml).toContain(`<NameIDFormat>${PERSISTENT_NAMEID_FORMAT}</NameIDFormat>`);
    expect(xml).toContain('WantAssertionsSigned="true"');
    // A provider without its own entity id uses the URL of its metadata.
    await addProvider(orgA.id, 'saml-noid', { saml_sp_entity_id: null, enabled: false });
    const own = await browser.get('/api/v1/auth/saml/saml-noid/metadata');
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain(`entityID="${APP_ORIGIN}/api/v1/auth/saml/saml-noid/metadata"`);
    expect((await browser.get('/api/v1/auth/saml/no-such-idp/metadata')).statusCode).toBe(404);
    expect((await browser.get('/api/v1/auth/saml/oidc-only/metadata')).statusCode).toBe(404);
  });

  // ---------------------------------------------------------------------------------------------------- start

  it('starts with an unsigned HTTP-Redirect AuthnRequest, a hashed transaction and the binding cookie', async () => {
    const browser = new Browser(ctx.app);
    const response = await start(browser, 'saml-a', { returnTo: '/controls?ms=isms' });
    const url = new URL(redirectOf(response));
    const relayState = url.searchParams.get('RelayState')!;
    expect(relayState).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has('Signature')).toBe(false);
    const request = authnRequestOf(url.href);
    const requestId = /\sID="([^"]+)"/.exec(request)![1]!;
    expect(requestId).toMatch(/^_[0-9a-f]{40}$/);
    expect(request).toContain(`AssertionConsumerServiceURL="${APP_ORIGIN}/api/v1/auth/saml/saml-a/acs"`);
    expect(request).toContain(`>${SP_ENTITY_ID}</saml:Issuer>`);
    expect(request).toContain(`Format="${PERSISTENT_NAMEID_FORMAT}"`);
    expect(request).toContain('ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"');
    expect(request).not.toContain('ForceAuthn');
    expect(request).not.toContain('RequestedAuthnContext');

    const binding = browser.cookies.get(BINDING_COOKIE);
    expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('Path=/api/v1/auth/saml/');
    expect(setCookie).toContain('HttpOnly');
    // The test profile has security.cookie_secure false: no Secure, so SameSite=Lax (F.9).
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=600');

    const stored = (await transactionOf(relayState))!;
    expect(stored).toMatchObject({ kind: 'saml_login', identity_provider_id: providerA, organization_id: orgA.id, user_id: null, target_id: null, saml_request_id: requestId, return_to: '/controls?ms=isms' });
    expect(stored.browser_binding_hash.equals(sha256(binding!))).toBe(true);
    expect(stored.expires_at.getTime() - ctx.clock.now().getTime()).toBe(10 * 60_000);
  });

  it('sets the binding cookie with SameSite=None and Secure when cookies are secure', async () => {
    const secure = await createSamlApp(db, { MSCD__SECURITY__COOKIE_SECURE: 'true' });
    try {
      const response = await new Browser(secure.app).get('/api/v1/auth/saml/saml-a/start');
      expect(response.statusCode).toBe(302);
      const setCookie = String(response.headers['set-cookie']);
      expect(setCookie).toContain(`${BINDING_COOKIE}=`);
      expect(setCookie).toContain('SameSite=None');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Path=/api/v1/auth/saml/');
    } finally {
      await secure.close();
    }
  });

  it('answers 404 for unknown, disabled and non-SAML providers at start', async () => {
    const browser = new Browser(ctx.app);
    expect((await start(browser, 'no-such-idp')).statusCode).toBe(404);
    expect((await start(browser, 'oidc-only')).statusCode).toBe(404);
    const disabled = await addProvider(orgA.id, 'saml-off', { enabled: false });
    expect((await start(browser, 'saml-off')).statusCode).toBe(404);
    await updateProvider(disabled, { enabled: true });
    expect((await start(browser, 'saml-off')).statusCode).toBe(302);
    expect((await browser.get('/api/v1/auth/saml/saml-a/start?returnTo=https://evil.example/')).statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------------------------------- sign-in

  it('signs in a pre-registered persistent NameID, continues with the local TOTP step and pins the session to the provider organisation', async () => {
    const user = await addUser('saml.user', [orgB, orgA], { factor: true });
    const kcUser = await keycloakUser();
    const browser = new Browser(ctx.app);
    const startResponse = await start(browser, 'saml-a', { returnTo: '/controls?ms=isms' });
    const relayState = new URL(redirectOf(startResponse)).searchParams.get('RelayState')!;
    const fields = await atKeycloak(String(startResponse.headers.location), kcUser.login, 'saml-a');
    expect(fields.RelayState).toBe(relayState);
    const xml = responseXml(fields);
    expect(xml).toContain(`Format="${PERSISTENT_NAMEID_FORMAT}"`);
    const nameId = nameIdOf(fields);
    await preRegister(providerA, nameId, user.id);

    const done = await postAcs(browser, 'saml-a', fields);
    expect(done.statusCode, done.body).toBe(302);
    const location = String(done.headers.location);
    expect(location).toMatch(/^\/login\/mfa#csrf=[A-Za-z0-9_-]+$/);
    expect(browser.cookies.has(BINDING_COOKIE)).toBe(false);
    const pending = await sessionRow(db, browser.session!);
    expect(pending).toMatchObject({ state: 'mfa_pending', auth_method: 'saml', identity_provider_id: providerA, auth_org_id: orgA.id, organization_id: orgA.id, user_id: user.id });
    expect(pending.amr).toEqual([]);
    // The transaction is gone (single use) and the assertion id is kept until its validity ends.
    expect(await transactionOf(relayState)).toBeUndefined();
    const seen = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.saml_assertion_seen').selectAll().where('identity_provider_id', '=', providerA).where('assertion_id_hash', '=', sha256(assertionIdOf(fields))).executeTakeFirstOrThrow(),
    );
    expect(seen.expires_at.getTime()).toBeGreaterThan(Date.now());

    browser.csrfToken = fragmentCsrf(location);
    ctx.clock.advance(30_000);
    const verify = await browser.post('/api/v1/auth/mfa/verify', { code: codeAt(user.secret!, ctx.clock) });
    expect(verify.statusCode, verify.body).toBe(200);
    const active = await sessionRow(db, browser.session!);
    expect(active).toMatchObject({ state: 'active', auth_method: 'saml', identity_provider_id: providerA, auth_org_id: orgA.id });
    const me = await browser.get('/api/v1/me');
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({ user: { id: user.id }, org: { slug: 'samla' }, session: { authMethod: 'saml' } });
    const login = (await auditOf(user.id, 'auth.login')).at(-1);
    expect(login?.after).toMatchObject({ method: 'saml', identityProviderId: providerA, secondFactor: 'totp' });
    expect(login?.organization_id).toBe(orgA.id);
    expect((await identities(user.id))[0]!.last_login_at).not.toBeNull();
  });

  it('opens an active session at once when AuthnContextClassRef is one of the provider MFA contexts', async () => {
    // Learn the context Keycloak sends, then accept it as MFA proof for a provider of its own.
    const probeUser = await keycloakUser();
    const probe = await atKeycloak(redirectOf(await start(new Browser(ctx.app), 'saml-a')), probeUser.login, 'saml-a');
    const context = authnContextOf(probe);
    const mfaProvider = await addProvider(orgA.id, 'saml-mfa', { saml_mfa_authn_contexts: [context] });
    const user = await addUser('saml.idpmfa', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    const browser = new Browser(ctx.app);
    const { location, nameId } = await samlSignIn(browser, 'saml-mfa', mfaProvider, kcUser.login, { userId: user.id, query: { returnTo: '/overview' } });
    expect(location).toBe('/overview');
    const session = await sessionRow(db, browser.session!);
    expect(session).toMatchObject({ state: 'active', auth_method: 'saml', identity_provider_id: mfaProvider, auth_org_id: orgA.id });
    expect(session.amr).toEqual(['mfa']);
    expect(session.mfa_at).toBeNull();
    const login = (await auditOf(user.id, 'auth.login')).at(-1);
    expect(login?.after).toMatchObject({ method: 'saml', provider: 'saml-mfa', subject: nameId, secondFactor: 'idp_mfa', authnContext: [context] });
  });

  it('refuses a sign-in without MFA context when the provider rejects it (mfa_required_by_policy)', async () => {
    const strict = await addProvider(orgA.id, 'saml-strict', { mfa_fallback: 'reject' });
    const user = await addUser('saml.strict', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    const browser = new Browser(ctx.app);
    const { location } = await samlSignIn(browser, 'saml-strict', strict, kcUser.login, { userId: user.id });
    expect(location).toBe('/login?error=mfa_required_by_policy');
    expect(browser.session).toBeUndefined();
    expect(await openSessions(db, user.id)).toEqual([]);
    expect((await providerFailures(strict)).at(-1)).toMatchObject({ method: 'saml', error: 'mfa_required_by_policy', reason: 'mfa_context_missing' });
  });

  it('sends a user without a factor to the enrolment step', async () => {
    const user = await addUser('saml.nofactor', [orgA]);
    const kcUser = await keycloakUser();
    const browser = new Browser(ctx.app);
    const { location } = await samlSignIn(browser, 'saml-a', providerA, kcUser.login, { userId: user.id });
    expect(location).toMatch(/^\/login\/enrol#csrf=/);
    expect(await sessionRow(db, browser.session!)).toMatchObject({ state: 'mfa_enrolment', auth_method: 'saml' });
  });

  it('answers no_account for a NameID linked to nobody, never matching an account by email', async () => {
    const kcUser = await keycloakUser();
    // An account with the asserted email exists in the provider's organisation, but nothing links the NameID.
    await addLocalUser(db, ctx.moduleRef, { handle: kcUser.email.split('@')[0]!, memberships: [{ org: orgA }] });
    const browser = new Browser(ctx.app);
    const { location } = await samlSignIn(browser, 'saml-a', providerA, kcUser.login);
    expect(location).toBe('/login?error=no_account');
    expect(browser.session).toBeUndefined();
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ error: 'no_account', reason: 'no_link' });
  });

  it('refuses the identity of organisation A through the provider of organisation B', async () => {
    const user = await addUser('saml.orga', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    await samlSignIn(new Browser(ctx.app), 'saml-a', providerA, kcUser.login, { userId: user.id });
    const { location } = await samlSignIn(new Browser(ctx.app), 'saml-b', providerB, kcUser.login);
    expect(location).toBe('/login?error=no_account');
  });

  // ---------------------------------------------------------------------------------------------- refusals

  it('rejects an unsigned assertion, also inside a signed response, and a fully unsigned response', async () => {
    const user = await addUser('saml.unsigned', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    // The NameID is registered from a first, signed sign-in, so only the signature can refuse the next ones.
    const first = await samlSignIn(new Browser(ctx.app), 'saml-a', providerA, kcUser.login, { userId: user.id });
    expect(first.location).toMatch(/^\/login\/mfa#csrf=/);

    await withClientAttributes({ 'saml.assertion.signature': 'false' }, async () => {
      const browser = new Browser(ctx.app);
      const fields = await atKeycloak(redirectOf(await start(browser, 'saml-a')), kcUser.login, 'saml-a');
      const xml = responseXml(fields);
      // The response is signed, the assertion is not.
      expect(xml).toMatch(/<(?:dsig|ds):Signature/);
      expect(/<saml:Assertion\b[\s\S]*<(?:dsig|ds):Signature[\s\S]*<\/saml:Assertion>/.test(xml)).toBe(false);
      const done = await postAcs(browser, 'saml-a', fields);
      expect(done.headers.location).toBe('/login?error=idp_error');
      expect(browser.session).toBeUndefined();
      expect((await providerFailures(providerA)).at(-1)).toMatchObject({ error: 'idp_error', reason: 'assertion_invalid:signature_invalid' });
    });

    await withClientAttributes({ 'saml.assertion.signature': 'false', 'saml.server.signature': 'false' }, async () => {
      const browser = new Browser(ctx.app);
      const fields = await atKeycloak(redirectOf(await start(browser, 'saml-a')), kcUser.login, 'saml-a');
      expect(responseXml(fields)).not.toMatch(/<(?:dsig|ds):Signature/);
      const done = await postAcs(browser, 'saml-a', fields);
      expect(done.headers.location).toBe('/login?error=idp_error');
      expect((await providerFailures(providerA)).at(-1)).toMatchObject({ error: 'idp_error', reason: 'assertion_invalid:signature_invalid' });
    });
    expect((await openSessions(db, user.id)).length).toBe(1);
  });

  it('rejects an assertion for another audience', async () => {
    const other = await addProvider(orgA.id, 'saml-aud');
    const user = await addUser('saml.audience', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    const browser = new Browser(ctx.app);
    const fields = await atKeycloak(redirectOf(await start(browser, 'saml-aud')), kcUser.login, 'saml-aud');
    await preRegister(other, nameIdOf(fields), user.id);
    expect(responseXml(fields)).toContain(`<saml:Audience>${SP_ENTITY_ID}</saml:Audience>`);
    // This SP now expects another entity id: the assertion Keycloak issued for mscd-dev-sp is not meant for it.
    await updateProvider(other, { saml_sp_entity_id: 'https://other-sp.example/metadata' });
    const done = await postAcs(browser, 'saml-aud', fields);
    expect(done.headers.location).toBe('/login?error=idp_error');
    expect(browser.session).toBeUndefined();
    expect((await providerFailures(other)).at(-1)).toMatchObject({ error: 'idp_error', reason: 'assertion_invalid:audience_mismatch' });
  });

  it('rejects a response to an earlier AuthnRequest (reused InResponseTo) and a replayed assertion', async () => {
    const user = await addUser('saml.replay', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    const kcBrowser = new KeycloakBrowser();
    const first = new Browser(ctx.app);
    const firstRedirect = redirectOf(await start(first, 'saml-a'));
    const firstRequestId = /\sID="([^"]+)"/.exec(authnRequestOf(firstRedirect))![1]!;
    const responseA = await atKeycloak(firstRedirect, kcUser.login, 'saml-a', kcBrowser);
    await preRegister(providerA, nameIdOf(responseA), user.id);
    const ok = await postAcs(first, 'saml-a', responseA);
    expect(String(ok.headers.location)).toMatch(/^\/login\/mfa#csrf=/);

    // The same AuthnRequest again: Keycloak's session answers with a new assertion that responds to the first request.
    const responseB = await atKeycloak(firstRedirect, kcUser.login, 'saml-a', kcBrowser);
    expect(assertionIdOf(responseB)).not.toBe(assertionIdOf(responseA));
    expect(responseInResponseTo(responseXml(responseB))).toBe(firstRequestId);

    // Posted with its own RelayState: that transaction is used up.
    const late = await postAcs(first, 'saml-a', responseB);
    expect(late.headers.location).toBe('/login?error=expired');

    // Posted into a new transaction of the same browser: InResponseTo is not this transaction's request.
    const second = new Browser(ctx.app);
    const secondState = new URL(redirectOf(await start(second, 'saml-a'))).searchParams.get('RelayState')!;
    const reused = await postAcs(second, 'saml-a', { ...responseB, RelayState: secondState });
    expect(reused.headers.location).toBe('/login?error=expired');
    expect(second.session).toBeUndefined();
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ error: 'expired', reason: 'in_response_to_mismatch' });
    expect(await transactionOf(secondState)).toBeUndefined();

    // The first assertion again, in a fresh transaction: its id was used.
    const third = new Browser(ctx.app);
    const thirdState = new URL(redirectOf(await start(third, 'saml-a'))).searchParams.get('RelayState')!;
    const replayed = await postAcs(third, 'saml-a', { ...responseA, RelayState: thirdState });
    expect(replayed.headers.location).toBe('/login?error=expired');
    expect(third.session).toBeUndefined();
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ error: 'expired', reason: 'assertion_replayed' });
    expect((await openSessions(db, user.id)).length).toBe(1);
  });

  it('fails an ACS post without the binding cookie or with another one, and consumes the transaction', async () => {
    const user = await addUser('saml.binding', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    const browser = new Browser(ctx.app);
    const redirect = redirectOf(await start(browser, 'saml-a'));
    const relayState = new URL(redirect).searchParams.get('RelayState')!;
    const fields = await atKeycloak(redirect, kcUser.login, 'saml-a');
    await preRegister(providerA, nameIdOf(fields), user.id);
    browser.cookies.delete(BINDING_COOKIE);
    const done = await postAcs(browser, 'saml-a', fields);
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/login?error=expired');
    expect(browser.session).toBeUndefined();
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ error: 'expired', reason: 'binding_mismatch' });
    // Single use: the transaction is gone, so the right cookie cannot finish it later.
    expect(await transactionOf(relayState)).toBeUndefined();

    // Another browser's binding cookie does not fit this transaction either.
    const victim = new Browser(ctx.app);
    const victimRedirect = redirectOf(await start(victim, 'saml-a'));
    const attacker = new Browser(ctx.app);
    await start(attacker, 'saml-a');
    const victimFields = await atKeycloak(victimRedirect, kcUser.login, 'saml-a');
    const stolen = await postAcs(attacker, 'saml-a', victimFields);
    expect(stolen.headers.location).toBe('/login?error=expired');
    expect(attacker.session).toBeUndefined();
    expect(await openSessions(db, user.id)).toEqual([]);
  });

  it('refuses an expired transaction, a missing RelayState, a provider disabled meanwhile and the ACS of another provider', async () => {
    const user = await addUser('saml.expired', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    const browser = new Browser(ctx.app);
    const fields = await atKeycloak(redirectOf(await start(browser, 'saml-a')), kcUser.login, 'saml-a');
    await preRegister(providerA, nameIdOf(fields), user.id);
    ctx.clock.advance(11 * 60_000);
    expect((await postAcs(browser, 'saml-a', fields)).headers.location).toBe('/login?error=expired');
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ reason: 'transaction_expired' });

    const noRelay = new Browser(ctx.app);
    const noRelayFields = await atKeycloak(redirectOf(await start(noRelay, 'saml-a')), kcUser.login, 'saml-a');
    const { RelayState: _dropped, ...withoutRelay } = noRelayFields;
    expect((await postAcs(noRelay, 'saml-a', withoutRelay)).headers.location).toBe('/login?error=expired');

    const switching = await addProvider(orgA.id, 'saml-switch');
    const disabledBrowser = new Browser(ctx.app);
    const switchFields = await atKeycloak(redirectOf(await start(disabledBrowser, 'saml-switch')), kcUser.login, 'saml-switch');
    await updateProvider(switching, { enabled: false });
    expect((await postAcs(disabledBrowser, 'saml-switch', switchFields)).headers.location).toBe('/login?error=idp_error');
    expect((await providerFailures(switching)).at(-1)).toMatchObject({ reason: 'provider_disabled' });

    // A response of provider A's transaction posted to provider B's ACS.
    const crossBrowser = new Browser(ctx.app);
    const crossFields = await atKeycloak(redirectOf(await start(crossBrowser, 'saml-a')), kcUser.login, 'saml-a');
    expect((await postAcs(crossBrowser, 'saml-b', crossFields)).headers.location).toBe('/login?error=expired');
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ reason: 'provider_mismatch' });
    expect(await openSessions(db, user.id)).toEqual([]);
  });

  it('refuses a NameID that is not persistent', async () => {
    const kcUser = await keycloakUser();
    await withClientAttributes({ saml_name_id_format: 'email' }, async () => {
      const browser = new Browser(ctx.app);
      const fields = await atKeycloak(redirectOf(await start(browser, 'saml-a')), kcUser.login, 'saml-a');
      expect(responseXml(fields)).not.toContain(`Format="${PERSISTENT_NAMEID_FORMAT}"`);
      expect((await postAcs(browser, 'saml-a', fields)).headers.location).toBe('/login?error=idp_error');
      expect((await providerFailures(providerA)).at(-1)).toMatchObject({ error: 'idp_error', reason: 'nameid_not_persistent' });
    });
  });

  // ---------------------------------------------------------------------------------------- invitations, links

  it('redeems an invitation through a SAML provider of the inviting organisation, once only', async () => {
    const kcUser = await keycloakUser();
    const invited = await ctx.moduleRef
      .get(TenantScope)
      .withPlatform((trx) => ctx.moduleRef.get(InvitationService).inviteUser(trx, { orgId: orgA.id, email: kcUser.email, actor: { userId: null, kind: 'operator' } }), {
        scope: 'cli',
      });
    const token = invited.invitation!.token;
    const checksBefore = ctx.licence.userChecks.length;
    const browser = new Browser(ctx.app);
    const startResponse = await start(browser, 'saml-a', { invitation: token });
    const redirect = redirectOf(startResponse);
    // An invitation binds the identity for good: the person signs in at the provider now.
    expect(authnRequestOf(redirect)).toContain('ForceAuthn="true"');
    const relayState = new URL(redirect).searchParams.get('RelayState')!;
    expect((await transactionOf(relayState))?.target_id).toBe(invited.invitation!.invitationId);
    const fields = await atKeycloak(redirect, kcUser.login, 'saml-a');
    const done = await postAcs(browser, 'saml-a', fields);
    expect(String(done.headers.location)).toMatch(/^\/login\/enrol#csrf=/);
    expect(await sessionRow(db, browser.session!)).toMatchObject({ state: 'mfa_enrolment', user_id: invited.userId, auth_method: 'saml', auth_org_id: orgA.id });
    expect(await identities(invited.userId)).toEqual([
      expect.objectContaining({ identity_provider_id: providerA, subject: nameIdOf(fields), link_method: 'invitation', email_at_link: null }),
    ]);
    const state = await inScope(db.migrator, { platformScope: true }, async (trx) => ({
      user: await trx.selectFrom('platform.app_user').select('status').where('id', '=', invited.userId).executeTakeFirstOrThrow(),
      membership: await trx.selectFrom('platform.org_membership').select('status').where('user_id', '=', invited.userId).where('organization_id', '=', orgA.id).executeTakeFirstOrThrow(),
      invitation: await trx.selectFrom('platform.invitation').select('used_at').where('id', '=', invited.invitation!.invitationId).executeTakeFirstOrThrow(),
    }));
    expect(state.user.status).toBe('active');
    expect(state.membership.status).toBe('active');
    expect(state.invitation.used_at).not.toBeNull();
    expect(ctx.licence.userChecks.slice(checksBefore)).toEqual([orgA.id]);
    expect((await auditOf(invited.userId, 'identity.linked')).at(-1)?.after).toMatchObject({ linkMethod: 'invitation', provider: 'saml-a' });

    const second = await start(new Browser(ctx.app), 'saml-a', { invitation: token });
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toBe('/login?error=invitation_invalid');
    // An invitation of organisation A cannot be redeemed through organisation B's provider.
    const forA = await ctx.moduleRef
      .get(TenantScope)
      .withPlatform(
        (trx) => ctx.moduleRef.get(InvitationService).inviteUser(trx, { orgId: orgA.id, email: `inv-${randomBytes(3).toString('hex')}@keycloak.test`, actor: { userId: null, kind: 'operator' } }),
        { scope: 'cli' },
      );
    expect((await start(new Browser(ctx.app), 'saml-b', { invitation: forA.invitation!.token })).headers.location).toBe('/login?error=invitation_invalid');
  });

  it('links a SAML identity from a local session with a recent second factor, then signs in with it', async () => {
    const user = await addUser('saml.link', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    const browser = await signIn(ctx, user);
    const link = await browser.post('/api/v1/me/identities/saml-a/link');
    expect(link.statusCode, link.body).toBe(200);
    const redirectUrl = link.json().redirectUrl as string;
    expect(redirectUrl.startsWith(`${kc.issuer}/protocol/saml?`)).toBe(true);
    expect(authnRequestOf(redirectUrl)).toContain('ForceAuthn="true"');
    expect(String(link.headers['set-cookie'])).toContain(`${BINDING_COOKIE}=`);
    const relayState = new URL(redirectUrl).searchParams.get('RelayState')!;
    expect(await transactionOf(relayState)).toMatchObject({ kind: 'saml_link', user_id: user.id, identity_provider_id: providerA });

    const sessionBefore = browser.session;
    const fields = await atKeycloak(redirectUrl, kcUser.login, 'saml-a');
    const done = await postAcs(browser, 'saml-a', fields);
    expect(done.headers.location).toBe('/');
    expect(browser.session).toBe(sessionBefore);
    const nameId = nameIdOf(fields);
    expect(await identities(user.id)).toEqual([expect.objectContaining({ identity_provider_id: providerA, subject: nameId, link_method: 'session', linked_by: user.id })]);
    expect((await auditOf(user.id, 'identity.linked')).at(-1)?.after).toMatchObject({ linkMethod: 'session', provider: 'saml-a', subject: nameId });

    // The linked identity now signs the user in.
    const later = new Browser(ctx.app);
    const { location } = await samlSignIn(later, 'saml-a', providerA, kcUser.login);
    expect(location).toMatch(/^\/login\/mfa#csrf=/);
    expect((await sessionRow(db, later.session!)).user_id).toBe(user.id);
  });

  it('refuses a SAML link from another browser and for a NameID linked to someone else', async () => {
    const owner = await addUser('saml.owner', [orgA], { factor: true });
    const kcUser = await keycloakUser();
    await samlSignIn(new Browser(ctx.app), 'saml-a', providerA, kcUser.login, { userId: owner.id });

    const user = await addUser('saml.taker', [orgA], { factor: true });
    const browser = await signIn(ctx, user);
    const link = await browser.post('/api/v1/me/identities/saml-a/link');
    expect(link.statusCode).toBe(200);
    // Another browser, without the binding cookie of the link.
    const fields = await atKeycloak(link.json().redirectUrl, kcUser.login, 'saml-a');
    const elsewhere = new Browser(ctx.app);
    expect((await postAcs(elsewhere, 'saml-a', fields)).headers.location).toBe('/login?error=expired');

    const again = await browser.post('/api/v1/me/identities/saml-a/link');
    const fieldsAgain = await atKeycloak(again.json().redirectUrl, kcUser.login, 'saml-a');
    expect((await postAcs(browser, 'saml-a', fieldsAgain)).headers.location).toBe('/login?error=idp_error');
    expect((await providerFailures(providerA)).at(-1)).toMatchObject({ method: 'saml', error: 'idp_error', reason: 'subject_linked_to_another_account' });
    expect(await identities(user.id)).toEqual([]);
  });
});
