// Identity provider administration and the login page's provider list (build plan D.3, D.2 `AuthProviders`, F.8,
// D-25, F.1; WP-16). The OIDC providers point at the Keycloak of the SSO suite (MSCD_TEST_SSO=1,
// test/setup/keycloak.ts), so discovery runs for real. Permissions come from the F.6 matrix over the members'
// organisation roles (`idp.manage` for Tenant Admins).
import { randomBytes, randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { evaluatePermission, permissionsFor, type BusinessRole, type OrgRole, type Permission, type PermissionSet } from '@mscd/shared';
import { createSelfSignedCertificate } from '@mscd/mock-providers';
import type { InjectOptions } from 'fastify';
import type { Insertable } from 'kysely';
import { Logger } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { Clock } from '../../../src/common/clock';
import { LICENCE_GATE, PERMISSION_EVALUATOR, type PermissionEvaluator, type PermissionTarget, type Principal } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { IdentityProviderTable } from '../../../src/db/types/platform';
import { AdminIdpModule } from '../../../src/modules/admin-idp/admin-idp.module';
import { normaliseCertificate } from '../../../src/modules/admin-idp/identity-providers.service';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { DiscoveryError, OidcDiscovery } from '../../../src/modules/identity/oidc/discovery';
import { SessionService } from '../../../src/modules/identity/session.service';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { SecretBox } from '../../../src/modules/keys/secret-box';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { inScope } from '../db/helpers';
import { addUser, APP_ORIGIN, Browser, FakeLicenceGate, mutableClock, resetRateLimits, signIn, type IdentityApp, type TestUser } from '../identity/helpers';
import { createTenant } from '../../setup/global-db';
import { KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET } from '../../setup/keycloak';
import { useTestDatabase, type TestDatabase } from '../../setup/test-db';

const keycloak = inject('mscdKeycloak');

/** PERMISSION_EVALUATOR over the F.6 matrix with the caller's organisation roles from the database. */
class OrgRoleEvaluator implements PermissionEvaluator {
  constructor(
    private readonly db: TestDatabase,
    private readonly tenancy: 'single' | 'multi',
  ) {}

  private async orgRoles(principal: Principal): Promise<OrgRole[]> {
    if (!principal.org) return [];
    const row = await inScope(this.db.migrator, { platformScope: true }, (trx) =>
      trx
        .selectFrom('platform.org_membership')
        .select('admin_roles')
        .where('organization_id', '=', principal.org!.id)
        .where('user_id', '=', principal.user.id)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    );
    return (row?.admin_roles ?? []) as OrgRole[];
  }

  async evaluate(principal: Principal, permission: Permission, _target: PermissionTarget): Promise<'full' | 'own' | null> {
    return evaluatePermission(permission, { tenancy: this.tenancy, msRoles: [], anyMsRoles: [], orgRoles: await this.orgRoles(principal), platformRoles: [] });
  }

  async permissionSet(principal: Principal): Promise<PermissionSet> {
    return { org: permissionsFor('org', { tenancy: this.tenancy, msRoles: [], anyMsRoles: [], orgRoles: await this.orgRoles(principal), platformRoles: [] }), ms: {} };
  }

  async rolesByMs(): Promise<Record<string, BusinessRole[]>> {
    return {};
  }
}

async function createAdminApp(db: TestDatabase, env: Record<string, string> = {}): Promise<IdentityApp> {
  const fullEnv = { MSCD__MAIL__SMTP__PORT: '9', ...env };
  const config = db.config(fullEnv);
  const clock = mutableClock(config, new Date());
  const licence = new FakeLicenceGate();

  @Global()
  @Module({ providers: [{ provide: LICENCE_GATE, useValue: licence }], exports: [LICENCE_GATE] })
  class FakeLicenceModule {}

  const moduleRef: TestingModule = await db
    .createTestingModule({ imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, AdminIdpModule, FakeLicenceModule] }, fullEnv)
    .overrideProvider(Clock)
    .useValue(clock.clock)
    .overrideProvider(PERMISSION_EVALUATOR)
    .useValue(new OrgRoleEvaluator(db, config.profile.tenancy.mode))
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, moduleRef, clock, licence, close: () => app.close() };
}

/** PATCH with the browser's cookies, CSRF token and the application's Origin. */
async function patch(ctx: IdentityApp, browser: Browser, url: string, body: unknown) {
  const headers: Record<string, string> = { origin: APP_ORIGIN, cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
  if (browser.csrfToken) headers['x-csrf-token'] = browser.csrfToken;
  return ctx.app.inject({ method: 'PATCH', url, headers, payload: body as InjectOptions['payload'] });
}

const describeSso = describe.skipIf(!keycloak);

describeSso('identity provider administration and the provider list', () => {
  const db = useTestDatabase('empty');
  const kc = keycloak!;
  let ctx: IdentityApp;
  let orgA: CreatedTenant;
  let orgB: CreatedTenant;
  let adminA: TestUser;
  let adminB: TestUser;
  let memberA: TestUser;
  let browserA: Browser;
  let browserB: Browser;

  const oidcRequest = (slug: string, extra: Record<string, unknown> = {}) => ({
    slug,
    kind: 'oidc',
    displayName: `Sign in with ${slug}`,
    icon: 'generic',
    oidc: { issuer: kc.issuer, clientId: KEYCLOAK_CLIENT_ID, clientSecret: KEYCLOAK_CLIENT_SECRET, scopes: 'openid email profile', subjectMode: 'sub' },
    ...extra,
  });

  async function insertProvider(orgId: string, slug: string, values: Partial<Insertable<IdentityProviderTable>> = {}): Promise<string> {
    const id = randomUUID();
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx
        .insertInto('platform.identity_provider')
        .values({ id, organization_id: orgId, slug, kind: 'oidc', display_name: `Sign in with ${slug}`, oidc_issuer: kc.issuer, oidc_client_id: KEYCLOAK_CLIENT_ID, ...values })
        .execute(),
    );
    return id;
  }

  async function verifyDomain(orgId: string, domain: string): Promise<void> {
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.insertInto('platform.verified_domain').values({ organization_id: orgId, domain, verified_by: 'test' }).execute());
  }

  async function auditOf(entityId: string) {
    return inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.audit_log').select(['action', 'after_data', 'before_data', 'organization_id']).where('entity_id', '=', entityId).orderBy('seq').execute(),
    );
  }

  beforeAll(async () => {
    orgA = await createTenant(db, 'idpa');
    orgB = await createTenant(db, 'idpb');
    ctx = await createAdminApp(db);
    adminA = await addUser(db, ctx.moduleRef, { handle: 'admin.a', memberships: [{ org: orgA, adminRoles: ['tenant_admin'] }], factor: true });
    adminB = await addUser(db, ctx.moduleRef, { handle: 'admin.b', memberships: [{ org: orgB, adminRoles: ['tenant_admin'] }], factor: true });
    memberA = await addUser(db, ctx.moduleRef, { handle: 'member.a', memberships: [{ org: orgA }], factor: true });
    browserA = await signIn(ctx, adminA);
    browserB = await signIn(ctx, adminB);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetRateLimits(db);
  });

  // ------------------------------------------------------------------------------------------------- create

  it('creates an OIDC provider after discovery, seals the client secret and never returns it', async () => {
    const created = await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-admin'));
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toContain(KEYCLOAK_CLIENT_SECRET);
    const view = created.json();
    expect(view).toMatchObject({
      slug: 'kc-admin',
      kind: 'oidc',
      enabled: true,
      oidc: { issuer: kc.issuer, clientId: KEYCLOAK_CLIENT_ID, scopes: 'openid email profile', subjectMode: 'sub', clientSecretSet: true },
      requireMfaClaim: true,
      mfaFallback: 'local_totp',
      jitProvisioning: false,
      allowedEmailDomains: [],
    });
    expect(view.acceptedAmr).toContain('otp');
    const row = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.identity_provider').selectAll().where('id', '=', view.id).executeTakeFirstOrThrow());
    expect(row.organization_id).toBe(orgA.id);
    expect(row.oidc_client_secret_sealed).toMatch(/^v1\./);
    const secrets = ctx.moduleRef.get(SecretBox);
    expect(await secrets.openText(row.oidc_client_secret_sealed!, { purpose: 'idp', providerId: row.id })).toBe(KEYCLOAK_CLIENT_SECRET);
    // The seal is bound to the provider id (AAD idp:<providerId>).
    await expect(secrets.openText(row.oidc_client_secret_sealed!, { purpose: 'idp', providerId: randomUUID() })).rejects.toThrow();
    const audit = await auditOf(view.id);
    expect(audit.map((a) => a.action)).toEqual(['idp.created']);
    expect(audit[0]!.organization_id).toBe(orgA.id);
    expect(JSON.stringify(audit)).not.toContain(KEYCLOAK_CLIENT_SECRET);

    // The new provider is usable at once: its start route redirects to Keycloak.
    const startResponse = await new Browser(ctx.app).get('/api/v1/auth/oidc/kc-admin/start');
    expect(startResponse.statusCode).toBe(302);
    expect(String(startResponse.headers.location).startsWith(`${kc.issuer}/protocol/openid-connect/auth?`)).toBe(true);
  });

  it('refuses a provider whose discovery fails, with the reason', async () => {
    const unreachable = await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-down', { oidc: { ...oidcRequest('x').oidc, issuer: 'http://localhost:9/realms/none' } }));
    expect(unreachable.statusCode).toBe(422);
    expect(unreachable.json()).toMatchObject({ messageKey: 'idp.discovery_failed', messages: { en: expect.stringContaining('could not be reached') } });
    const mismatch = await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-mismatch', { oidc: { ...oidcRequest('x').oidc, issuer: `${kc.issuer}/` } }));
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().messageKey).toBe('idp.discovery_failed');
    const rows = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.identity_provider').select('slug').where('slug', 'in', ['kc-down', 'kc-mismatch']).execute());
    expect(rows).toEqual([]);
  });

  it('refuses plain-HTTP issuers unless the profile allows them (demo and test only)', async () => {
    const config = db.config({ MSCD__IDENTITY__OIDC__ALLOW_INSECURE_HTTP: 'false' });
    const strict = new OidcDiscovery(config, ctx.moduleRef.get(SecretBox), ctx.moduleRef.get(Clock));
    const error = await strict.discover({ issuer: kc.issuer, clientId: KEYCLOAK_CLIENT_ID, clientSecret: KEYCLOAK_CLIENT_SECRET }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as DiscoveryError).reason).toBe('insecure_issuer');
    const lenient = new OidcDiscovery(db.config(), ctx.moduleRef.get(SecretBox), ctx.moduleRef.get(Clock));
    const configuration = await lenient.discover({ issuer: kc.issuer, clientId: KEYCLOAK_CLIENT_ID, clientSecret: KEYCLOAK_CLIENT_SECRET });
    expect(lenient.endpointsOf(configuration).issuer).toBe(kc.issuer);
  });

  it('allows JIT provisioning only with domains verified for the organisation', async () => {
    const domain = `jit-${randomBytes(3).toString('hex')}.mscd.test`;
    const refused = await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-jit', { jitProvisioning: true, allowedEmailDomains: [domain] }));
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ messageKey: 'idp.jit_domain_unverified', affected: [domain] });
    // A domain verified for another organisation does not count.
    await verifyDomain(orgB.id, domain);
    expect((await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-jit', { jitProvisioning: true, allowedEmailDomains: [domain] }))).statusCode).toBe(422);
    await verifyDomain(orgA.id, domain);
    const created = await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-jit', { jitProvisioning: true, allowedEmailDomains: [domain] }));
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ jitProvisioning: true, allowedEmailDomains: [domain] });
    // Without domains, or for SAML, JIT is a validation error.
    expect((await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-jit-none', { jitProvisioning: true, allowedEmailDomains: [] }))).statusCode).toBe(400);
  });

  it('validates the settings and refuses a slug in use, also by another organisation', async () => {
    await insertProvider(orgB.id, 'kc-of-b');
    const taken = await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-of-b'));
    expect(taken.statusCode).toBe(409);
    expect(taken.json().messageKey).toBe('idp.slug_taken');
    expect(taken.body).not.toContain(orgB.id);
    expect((await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-bad', { requireMfaClaim: false, mfaFallback: 'reject' }))).statusCode).toBe(400);
    const noOpenid = await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-bad', { oidc: { ...oidcRequest('x').oidc, scopes: 'email profile' } }));
    expect(noOpenid.statusCode).toBe(400);
    expect(noOpenid.json().errors).toEqual([expect.objectContaining({ path: 'body.oidc.scopes' })]);
    expect((await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-bad', { oidc: { ...oidcRequest('x').oidc, subjectMode: 'entra' } }))).statusCode).toBe(400);
  });

  it('creates a SAML provider with its certificates stored as PEM', async () => {
    const cert = createSelfSignedCertificate({ commonName: 'idp.example.test' });
    const bare = cert.certificatePem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    const body = {
      slug: 'adfs-a',
      kind: 'saml',
      displayName: 'Sign in with AD FS',
      icon: 'microsoft',
      saml: { entryPoint: 'https://adfs.example.test/adfs/ls/', idpIssuer: 'http://adfs.example.test/adfs/services/trust', idpCerts: [bare], spEntityId: 'mscd-sp', mfaAuthnContexts: ['http://schemas.microsoft.com/claims/multipleauthn'] },
    };
    const created = await browserA.post('/api/v1/admin/identity-providers', body);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ kind: 'saml', saml: { idpCertCount: 1, spEntityId: 'mscd-sp', entryPoint: 'https://adfs.example.test/adfs/ls/' } });
    const row = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.identity_provider').selectAll().where('slug', '=', 'adfs-a').executeTakeFirstOrThrow());
    expect(row.saml_idp_certs).toEqual([normaliseCertificate(cert.certificatePem)]);
    expect(row.saml_idp_certs![0]).toContain('-----BEGIN CERTIFICATE-----');

    const invalid = await browserA.post('/api/v1/admin/identity-providers', { ...body, slug: 'adfs-bad', saml: { ...body.saml, idpCerts: ['bm90IGEgY2VydGlmaWNhdGU='] } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().errors).toEqual([expect.objectContaining({ path: 'body.saml.idpCerts.0' })]);
    expect((await browserA.post('/api/v1/admin/identity-providers', { ...body, slug: 'adfs-jit', jitProvisioning: true, allowedEmailDomains: ['example.test'] })).statusCode).toBe(400);

    const tested = await browserA.post(`/api/v1/admin/identity-providers/${row.id}/test`);
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toEqual({
      ok: true,
      issuer: 'http://adfs.example.test/adfs/services/trust',
      endpoints: { singleSignOn: 'https://adfs.example.test/adfs/ls/', serviceProviderMetadata: `${APP_ORIGIN}/api/v1/auth/saml/adfs-a/metadata` },
    });
    const expired = createSelfSignedCertificate({ notBefore: new Date(Date.now() - 10 * 86_400_000), days: 1 });
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.identity_provider').set({ saml_idp_certs: [expired.certificatePem] }).where('id', '=', row.id).execute());
    const failing = await browserA.post(`/api/v1/admin/identity-providers/${row.id}/test`);
    expect(failing.json()).toMatchObject({ ok: false, message: expect.stringContaining('expired') });
  });

  // ------------------------------------------------------------------------------------------- organisation scope

  it('shows and changes only the providers of the session organisation', async () => {
    const ofB = await insertProvider(orgB.id, `kc-b-${randomBytes(2).toString('hex')}`);
    const listA = await browserA.get('/api/v1/admin/identity-providers');
    expect(listA.statusCode).toBe(200);
    expect(listA.json().map((p: { id: string }) => p.id)).not.toContain(ofB);
    const listB = await browserB.get('/api/v1/admin/identity-providers');
    expect(listB.json().map((p: { id: string }) => p.id)).toContain(ofB);
    for (const p of [...listA.json(), ...listB.json()] as Record<string, unknown>[]) {
      expect(JSON.stringify(p)).not.toMatch(/clientSecret"|sealed/);
    }
    expect((await patch(ctx, browserA, `/api/v1/admin/identity-providers/${ofB}`, { displayName: 'Taken over' })).statusCode).toBe(404);
    expect((await browserA.post(`/api/v1/admin/identity-providers/${ofB}/test`)).statusCode).toBe(404);
    const untouched = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.identity_provider').select('display_name').where('id', '=', ofB).executeTakeFirstOrThrow());
    expect(untouched.display_name).not.toBe('Taken over');

    // A member without the Tenant Admin role may not manage providers.
    const member = await signIn(ctx, memberA);
    expect((await member.get('/api/v1/admin/identity-providers')).statusCode).toBe(403);
    expect((await member.post('/api/v1/admin/identity-providers', oidcRequest('kc-member'))).statusCode).toBe(403);
  });

  // ------------------------------------------------------------------------------------------------- update

  it('changes settings, re-seals a new client secret and checks discovery again', async () => {
    const created = (await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-upd'))).json();
    const before = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.identity_provider').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow());
    const newSecret = `rotated-${randomBytes(6).toString('hex')}`;
    const updated = await patch(ctx, browserA, `/api/v1/admin/identity-providers/${created.id}`, { displayName: 'Keycloak (new)', oidc: { clientSecret: newSecret }, acceptedAmr: ['pwd', 'otp'] });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ displayName: 'Keycloak (new)', acceptedAmr: ['pwd', 'otp'], oidc: { clientSecretSet: true } });
    const after = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.identity_provider').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow());
    expect(after.oidc_client_secret_sealed).not.toBe(before.oidc_client_secret_sealed);
    expect(await ctx.moduleRef.get(SecretBox).openText(after.oidc_client_secret_sealed!, { purpose: 'idp', providerId: created.id })).toBe(newSecret);
    const audit = (await auditOf(created.id)).at(-1)!;
    expect(audit.action).toBe('idp.updated');
    expect(audit.after_data).toMatchObject({ displayName: 'Keycloak (new)', clientSecretReplaced: true });
    expect(audit.before_data).toMatchObject({ displayName: 'Sign in with kc-upd' });
    expect(JSON.stringify(audit)).not.toContain(newSecret);

    // A connection that does not work is not saved.
    const broken = await patch(ctx, browserA, `/api/v1/admin/identity-providers/${created.id}`, { oidc: { issuer: 'http://localhost:9/realms/none' } });
    expect(broken.statusCode).toBe(422);
    expect(broken.json().messageKey).toBe('idp.discovery_failed');
    const unchanged = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.identity_provider').select('oidc_issuer').where('id', '=', created.id).executeTakeFirstOrThrow());
    expect(unchanged.oidc_issuer).toBe(kc.issuer);
  });

  it('checks the settings as a whole after a change', async () => {
    const strict = (await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-strict', { mfaFallback: 'reject' }))).json();
    // The patch alone is valid, the result is not: requireMfaClaim false needs the local_totp fallback (F.5).
    const mixed = await patch(ctx, browserA, `/api/v1/admin/identity-providers/${strict.id}`, { requireMfaClaim: false });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().errors).toEqual([expect.objectContaining({ path: 'body.mfaFallback' })]);
    expect((await patch(ctx, browserA, `/api/v1/admin/identity-providers/${strict.id}`, { saml: { spEntityId: 'x' } })).statusCode).toBe(400);
    expect((await patch(ctx, browserA, `/api/v1/admin/identity-providers/${strict.id}`, { oidc: { subjectMode: 'entra' } })).statusCode).toBe(400);
    const domain = `late-${randomBytes(3).toString('hex')}.mscd.test`;
    const jit = await patch(ctx, browserA, `/api/v1/admin/identity-providers/${strict.id}`, { jitProvisioning: true, allowedEmailDomains: [domain] });
    expect(jit.statusCode).toBe(422);
    expect(jit.json().messageKey).toBe('idp.jit_domain_unverified');
    expect((await patch(ctx, browserA, `/api/v1/admin/identity-providers/${strict.id}`, { mfaFallback: 'local_totp', requireMfaClaim: false })).statusCode).toBe(200);
  });

  it('revokes the sessions signed in through a provider when it is disabled', async () => {
    const created = (await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-off'))).json();
    const user = await addUser(db, ctx.moduleRef, { handle: 'sso.user', memberships: [{ org: orgA }] });
    const issued = await ctx.moduleRef.get(TenantScope).withPlatform(
      (trx) =>
        ctx.moduleRef.get(SessionService).create(trx, {
          userId: user.id,
          organizationId: orgA.id,
          authOrgId: orgA.id,
          state: 'active',
          authMethod: 'oidc',
          identityProviderId: created.id,
          amr: ['pwd', 'otp'],
        }),
      { scope: 'auth' },
    );
    const disabled = await patch(ctx, browserA, `/api/v1/admin/identity-providers/${created.id}`, { enabled: false });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().enabled).toBe(false);
    const row = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.session').select(['revoked_at', 'revoke_reason']).where('id_hash', '=', issued.row.id_hash).executeTakeFirstOrThrow());
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoke_reason).toBe('idp_disabled');
    expect((await auditOf(created.id)).at(-1)?.after_data).toMatchObject({ enabled: false, sessionsRevoked: 1 });
    expect((await new Browser(ctx.app).get('/api/v1/auth/oidc/kc-off/start')).statusCode).toBe(404);
    // The admin's own local session is not affected.
    expect((await browserA.get('/api/v1/admin/identity-providers')).statusCode).toBe(200);
  });

  // ------------------------------------------------------------------------------------------------- test

  it('tests discovery and reports the endpoints or why it failed', async () => {
    const created = (await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-test'))).json();
    const ok = await browserA.post(`/api/v1/admin/identity-providers/${created.id}/test`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      ok: true,
      issuer: kc.issuer,
      endpoints: { authorization: `${kc.issuer}/protocol/openid-connect/auth`, token: `${kc.issuer}/protocol/openid-connect/token`, jwks: `${kc.issuer}/protocol/openid-connect/certs` },
    });
    const down = await insertProvider(orgA.id, 'kc-unreachable', { oidc_issuer: 'http://localhost:9/realms/none' });
    const failed = await browserA.post(`/api/v1/admin/identity-providers/${down}/test`);
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toEqual({ ok: false, issuer: 'http://localhost:9/realms/none', endpoints: {}, message: 'The issuer could not be reached' });
  });

  // ------------------------------------------------------------------------------------------- GET /auth/providers

  it('lists the enabled providers for the login page (single-tenant installation)', async () => {
    const suffix = randomBytes(2).toString('hex');
    await insertProvider(orgA.id, `list-a-${suffix}`, { display_name: 'Sign in with Microsoft', icon: 'microsoft' });
    await insertProvider(orgB.id, `list-b-${suffix}`, { display_name: 'Sign in with Google', icon: 'google' });
    await insertProvider(orgA.id, `list-off-${suffix}`, { enabled: false });
    const archived = await createTenant(db, `arch${suffix}`);
    await insertProvider(archived.id, `list-arch-${suffix}`);
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.organization').set({ status: 'archived' }).where('id', '=', archived.id).execute());
    ctx.moduleRef.get(TenantResolver).invalidate(archived.id);

    const all = await new Browser(ctx.app).get('/api/v1/auth/providers');
    expect(all.statusCode).toBe(200);
    const slugs = all.json().providers.map((p: { slug: string }) => p.slug);
    expect(slugs).toEqual(expect.arrayContaining([`list-a-${suffix}`, `list-b-${suffix}`]));
    expect(slugs).not.toContain(`list-off-${suffix}`);
    expect(slugs).not.toContain(`list-arch-${suffix}`);
    expect(all.json().local).toBe(true);
    expect(all.json().providers).toContainEqual({ slug: `list-a-${suffix}`, kind: 'oidc', label: 'Sign in with Microsoft', icon: 'microsoft' });

    const onlyA = (await new Browser(ctx.app).get('/api/v1/auth/providers?org=idpa')).json();
    expect(onlyA.providers.map((p: { slug: string }) => p.slug)).toContain(`list-a-${suffix}`);
    expect(onlyA.providers.map((p: { slug: string }) => p.slug)).not.toContain(`list-b-${suffix}`);
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.organization').set({ local_login: 'disabled' }).where('id', '=', orgB.id).execute());
    const onlyB = (await new Browser(ctx.app).get('/api/v1/auth/providers?org=idpb')).json();
    expect(onlyB.local).toBe(false);
    expect(onlyB.providers.map((p: { slug: string }) => p.slug)).toContain(`list-b-${suffix}`);
    await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.organization').set({ local_login: 'allowed' }).where('id', '=', orgB.id).execute());
    // The domain of an email names the organisation that verified it.
    const domain = `single-${suffix}.mscd.test`;
    await verifyDomain(orgB.id, domain);
    const byEmail = (await new Browser(ctx.app).get(`/api/v1/auth/providers?email=${encodeURIComponent(`maya@${domain}`)}`)).json();
    expect(byEmail.providers.map((p: { slug: string }) => p.slug)).toContain(`list-b-${suffix}`);
    expect(byEmail.providers.map((p: { slug: string }) => p.slug)).not.toContain(`list-a-${suffix}`);
    expect((await new Browser(ctx.app).get('/api/v1/auth/providers?org=NOPE')).statusCode).toBe(400);
  });

  it('lists the providers of one organisation only in multi-tenant mode', async () => {
    const multi = await createAdminApp(db, { MSCD__TENANCY__MODE: 'multi', MSCD__TENANCY__ISOLATION: 'schema' });
    try {
      const suffix = randomBytes(2).toString('hex');
      await insertProvider(orgA.id, `multi-a-${suffix}`);
      await insertProvider(orgB.id, `multi-b-${suffix}`);
      const domain = `multi-${suffix}.mscd.test`;
      await verifyDomain(orgA.id, domain);

      const none = (await new Browser(multi.app).get('/api/v1/auth/providers')).json();
      expect(none).toEqual({ local: true, providers: [] });
      const byOrg = (await new Browser(multi.app).get('/api/v1/auth/providers?org=idpb')).json();
      expect(byOrg.providers.map((p: { slug: string }) => p.slug)).toContain(`multi-b-${suffix}`);
      expect(byOrg.providers.map((p: { slug: string }) => p.slug)).not.toContain(`multi-a-${suffix}`);
      const byEmail = (await new Browser(multi.app).get(`/api/v1/auth/providers?email=${encodeURIComponent(`rina@${domain}`)}`)).json();
      expect(byEmail.providers.map((p: { slug: string }) => p.slug)).toContain(`multi-a-${suffix}`);
      expect(byEmail.providers.map((p: { slug: string }) => p.slug)).not.toContain(`multi-b-${suffix}`);
      const unknownDomain = (await new Browser(multi.app).get('/api/v1/auth/providers?email=someone%40unverified.mscd.test')).json();
      expect(unknownDomain).toEqual({ local: true, providers: [] });
      const unknownOrg = (await new Browser(multi.app).get('/api/v1/auth/providers?org=nosuchorg')).json();
      expect(unknownOrg).toEqual({ local: true, providers: [] });
    } finally {
      await multi.close();
    }
  });

  it('replays a create with the same Idempotency-Key', async () => {
    const key = `idp-${randomBytes(6).toString('hex')}`;
    const first = await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-idem'), { headers: { 'idempotency-key': key } });
    expect(first.statusCode, first.body).toBe(201);
    const second = await browserA.post('/api/v1/admin/identity-providers', oidcRequest('kc-idem'), { headers: { 'idempotency-key': key } });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
  });
});
