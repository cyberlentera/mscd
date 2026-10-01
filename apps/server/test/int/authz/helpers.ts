// Helpers of the authorisation and admin-user integration tests (WP-39): an api application on a test database with
// the real session resolver, role-based evaluator, scope policy and admin routes, a fake licence gate and a mutable
// clock; fixture organisations, systems, users and role grants; sessions written directly through `SessionService`
// (any sign-in method, as the OIDC and guest flows of other work packages create them); and a client that keeps the
// session cookie and sends the CSRF header.
import { Global, Module, type Type } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { AuthMethod, BusinessRole, OrgRole } from '@mscd/shared';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { Logger } from 'nestjs-pino';
import { Clock } from '../../../src/common/clock';
import { LICENCE_GATE, type Principal, type TenantInfo } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { AdminUsersModule } from '../../../src/modules/admin-users/admin-users.module';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { NO_ORGANISATION } from '../../../src/modules/authz/authz-infra';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { SessionService } from '../../../src/modules/identity/session.service';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import type { TestDatabase } from '../../setup/test-db';
import { addFramework, inScope } from '../db/helpers';
import { APP_ORIGIN, COOKIE, FakeLicenceGate, mutableClock, type Mailpit, type MutableClock } from '../identity/helpers';

export { APP_ORIGIN, COOKIE, FakeLicenceGate };

export interface AuthzApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  clock: MutableClock;
  licence: FakeLicenceGate;
  close(): Promise<void>;
}

/** The api modules of the authorisation flows, with the admin-user routes, a fake licence gate and a mutable clock. */
export async function createAuthzApp(
  db: TestDatabase,
  options: { controllers?: Type<unknown>[]; mail?: Mailpit | null; env?: Record<string, string> } = {},
): Promise<AuthzApp> {
  const env: Record<string, string> = { ...(options.env ?? {}) };
  if (options.mail) {
    env.MSCD__MAIL__SMTP__HOST = options.mail.host;
    env.MSCD__MAIL__SMTP__PORT = String(options.mail.smtpPort);
  } else {
    env.MSCD__MAIL__SMTP__PORT ??= '9';
  }
  const config = db.config(env);
  const clock = mutableClock(config);
  const licence = new FakeLicenceGate();

  @Global()
  @Module({ providers: [{ provide: LICENCE_GATE, useValue: licence }], exports: [LICENCE_GATE] })
  class FakeLicenceModule {}

  const moduleRef = await db
    .createTestingModule(
      { controllers: options.controllers ?? [], imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, FakeLicenceModule, AdminUsersModule] },
      env,
    )
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

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

export interface Org {
  tenant: CreatedTenant;
  info: TenantInfo;
  systems: Record<string, string>;
}

/** An organisation with management systems (slug to id). */
export async function addOrg(db: TestDatabase, slug: string, systems: string[], frameworkVersionId?: string): Promise<Org> {
  const tenant = await createTenant(db, slug);
  const versionId = frameworkVersionId ?? (await addFramework(db.migrator, `FW${slug.toUpperCase()}`)).versionId;
  const ids: Record<string, string> = {};
  for (const [position, ms] of systems.entries()) {
    ids[ms] = await inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, async (trx) => {
      const row = await trx
        .insertInto('management_system')
        .values({
          slug: ms,
          code: ms.toUpperCase(),
          name: `${ms} system`,
          framework_version_id: versionId,
          scope_statement: 'Whole organisation',
          status: 'implementing',
          default_storage_repository_id: tenant.vaultRepositoryId,
          position,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }
  const info: TenantInfo = {
    id: tenant.id,
    slug,
    name: `Test organisation ${slug}`,
    schema: tenant.schemaName,
    status: 'active',
    timeZone: 'Asia/Jakarta',
    localLogin: 'allowed',
    demoDeployLabel: null,
    siteCount: 1,
    position: 0,
  };
  return { tenant, info, systems: ids };
}

export interface User {
  id: string;
  handle: string;
  email: string;
  displayName: string;
  kind: 'person' | 'guest';
}

/** A user with memberships (active unless stated) and optional organisation roles. */
export async function addUser(
  db: TestDatabase,
  handle: string,
  memberships: { org: Org; adminRoles?: OrgRole[]; status?: 'active' | 'invited' | 'disabled' }[],
  options: { kind?: 'person' | 'guest'; isDemo?: boolean; jobTitle?: string; status?: 'active' | 'invited' | 'disabled'; platformOperator?: boolean } = {},
): Promise<User> {
  const email = `${handle}@authz.test`;
  const displayName = `User ${handle}`;
  const id = await inScope(db.migrator, { platformScope: true }, async (trx) => {
    const user = await trx
      .insertInto('platform.app_user')
      .values({
        handle,
        email,
        display_name: displayName,
        job_title: options.jobTitle ?? null,
        kind: options.kind ?? 'person',
        is_demo: options.isDemo ?? false,
        status: options.status ?? 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [index, m] of memberships.entries()) {
      await trx
        .insertInto('platform.org_membership')
        .values({ organization_id: m.org.tenant.id, user_id: user.id, admin_roles: m.adminRoles ?? [], status: m.status ?? 'active', is_default: index === 0 })
        .execute();
    }
    if (options.platformOperator) await trx.insertInto('platform.platform_role').values({ user_id: user.id, role: 'platform_operator' }).execute();
    return user.id;
  });
  return { id, handle, email, displayName, kind: options.kind ?? 'person' };
}

/** A role grant row (active unless stated). */
export async function grantRole(
  db: TestDatabase,
  org: Org,
  user: User,
  ms: string,
  role: BusinessRole,
  options: { approvalStatus?: 'active' | 'pending_approval' | 'rejected'; validUntil?: Date | null; deleted?: boolean; isPrimary?: boolean } = {},
): Promise<string> {
  const validUntil = options.validUntil !== undefined ? options.validUntil : role === 'external_auditor' ? new Date(Date.now() + 14 * 86_400_000) : null;
  return inScope(db.migrator, { orgId: org.tenant.id, schema: org.tenant.schemaName }, async (trx) => {
    const row = await trx
      .insertInto('user_ms_role')
      .values({
        user_id: user.id,
        management_system_id: org.systems[ms]!,
        role,
        approval_status: options.approvalStatus ?? 'active',
        valid_until: validUntil,
        is_primary: options.isPrimary ?? false,
        deleted_at: options.deleted ? new Date() : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

/** Sets `organization.local_login` as the platform operator would, and drops the resolver cache entry. */
export async function setLocalLogin(db: TestDatabase, ctx: AuthzApp, org: Org, policy: 'allowed' | 'admins_only' | 'disabled'): Promise<void> {
  await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.organization').set({ local_login: policy }).where('id', '=', org.tenant.id).execute());
  ctx.moduleRef.get(TenantResolver).invalidate(org.tenant.id);
}

/** An enabled OIDC provider of an organisation. */
export async function addProvider(db: TestDatabase, org: Org, slug: string): Promise<string> {
  return inScope(db.migrator, { platformScope: true }, async (trx) => {
    const row = await trx
      .insertInto('platform.identity_provider')
      .values({ organization_id: org.tenant.id, slug, kind: 'oidc', display_name: `Sign in with ${slug}`, oidc_issuer: 'https://idp.example.test', oidc_client_id: 'mscd' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

/** Tenant audit trail entries of an organisation, oldest first. */
export async function tenantAudit(db: TestDatabase, org: Org, action?: string) {
  return inScope(db.migrator, { orgId: org.tenant.id, schema: org.tenant.schemaName }, async (trx) => {
    let query = trx.selectFrom('audit_trail').selectAll().orderBy('seq');
    if (action) query = query.where('action', '=', action);
    return query.execute();
  });
}

/** Platform audit entries, oldest first. */
export async function platformAudit(db: TestDatabase, action?: string) {
  return inScope(db.migrator, { platformScope: true }, async (trx) => {
    let query = trx.selectFrom('platform.audit_log').selectAll().orderBy('seq');
    if (action) query = query.where('action', '=', action);
    return query.execute();
  });
}

/** Forgets rate-limit buckets so tests do not share limits. */
export async function resetRateLimits(db: TestDatabase): Promise<void> {
  await sql`delete from platform.rate_limit_bucket`.execute(db.migrator);
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions and a client
// ---------------------------------------------------------------------------------------------------------------

export interface SessionOptions {
  org?: Org | null;
  authOrg?: Org | null;
  authMethod?: AuthMethod;
  identityProviderId?: string | null;
  authGrantId?: string | null;
  state?: 'active' | 'mfa_pending' | 'mfa_enrolment';
}

/** A client signed in as `user` with a session written through `SessionService` (no sign-in flow). */
export async function sessionFor(ctx: AuthzApp, user: User, options: SessionOptions = {}): Promise<Client> {
  const sessions = ctx.moduleRef.get(SessionService);
  const scope = ctx.moduleRef.get(TenantScope);
  const org = options.org === undefined ? null : options.org;
  const authOrg = options.authOrg === undefined ? org : options.authOrg;
  const context = org ? { orgId: org.tenant.id, schema: org.tenant.schemaName, userId: user.id } : { ...NO_ORGANISATION, userId: user.id };
  const issued = await scope.withTenant(context, (trx) =>
    sessions.create(trx, {
      userId: user.id,
      organizationId: org?.tenant.id ?? null,
      authOrgId: authOrg?.tenant.id ?? null,
      state: options.state ?? 'active',
      authMethod: options.authMethod ?? (user.kind === 'guest' ? 'guest' : 'local'),
      identityProviderId: options.identityProviderId ?? null,
      authGrantId: options.authGrantId ?? null,
      passwordAt: ctx.clock.now(),
      mfaAt: ctx.clock.now(),
    }),
  );
  const client = new Client(ctx.app);
  client.cookies.set(COOKIE, issued.cookieValue);
  client.csrfToken = issued.csrfToken;
  return client;
}

/** A browser-like client: one cookie jar, the CSRF token of the latest `Me` or sign-in response. */
export class Client {
  readonly cookies = new Map<string, string>();
  csrfToken: string | null = null;

  constructor(private readonly app: NestFastifyApplication) {}

  get session(): string | undefined {
    return this.cookies.get(COOKIE);
  }

  async request(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const all: Record<string, string> = { ...headers };
    if (this.cookies.size > 0) all.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') {
      all.origin = APP_ORIGIN;
      if (this.csrfToken) all['x-csrf-token'] = this.csrfToken;
    }
    const init: InjectOptions = { method, url, headers: all };
    if (body !== undefined) init.payload = body as InjectOptions['payload'];
    const response = await this.app.inject(init);
    for (const cookie of response.cookies as { name: string; value: string; maxAge?: number }[]) {
      if (cookie.value === '' || cookie.maxAge === 0) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    const type = response.headers['content-type']?.toString() ?? '';
    const json = /^application\/(problem\+)?json/.test(type) && response.body !== '' ? (response.json() as { csrfToken?: unknown }) : null;
    if (json && typeof json.csrfToken === 'string') this.csrfToken = json.csrfToken;
    return response;
  }

  get(url: string) {
    return this.request('GET', url);
  }

  post(url: string, body?: unknown) {
    return this.request('POST', url, body);
  }

  put(url: string, body?: unknown) {
    return this.request('PUT', url, body);
  }

  patch(url: string, body?: unknown) {
    return this.request('PATCH', url, body);
  }
}

/** A principal of a user in an organisation, as the session resolver would build it (for service-level tests). */
export function principalOf(user: User, org: Org | null, authMethod: AuthMethod = 'local'): Principal {
  const now = Date.now();
  return {
    user: { id: user.id, handle: user.handle, email: user.email, displayName: user.displayName, jobTitle: null, kind: user.kind },
    org: org?.info ?? null,
    session: {
      idHash: '00'.repeat(32),
      state: 'active',
      authMethod,
      authOrgId: org?.tenant.id ?? null,
      authGrantId: null,
      identityProviderId: null,
      idleExpiresAt: new Date(now + 3_600_000),
      absoluteExpiresAt: new Date(now + 8 * 3_600_000),
      passwordAt: null,
      mfaAt: null,
    },
  };
}
