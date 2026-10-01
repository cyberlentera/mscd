// Helpers of the identity integration tests (WP-11): a Mailpit container for the account and security emails
// (J.8), an api application on a test database with the identity module, a mutable clock and a controllable
// licence gate, a client that keeps cookies like a browser, and fixture users.
import { randomBytes } from 'node:crypto';
import { Global, Module, type Type } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { sql } from 'kysely';
import { Logger } from 'nestjs-pino';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { Clock } from '../../../src/common/clock';
import { BusinessRuleError } from '../../../src/common/problems';
import { LICENCE_GATE, type LicenceGate } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { hashSecret } from '../../../src/modules/identity/password-hasher';
import { sha256 } from '../../../src/modules/identity/tokens';
import { newTotpSecret, totpAt } from '../../../src/modules/identity/totp';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { SecretBox } from '../../../src/modules/keys/secret-box';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { inScope } from '../db/helpers';
import type { TestDatabase } from '../../setup/test-db';

/** `http.public_url` of profiles/test.yaml: the origin public POST routes must come from (F.2). */
export const APP_ORIGIN = 'http://localhost:4174';
/** The session cookie name with `security.cookie_secure: false` (F.1). */
export const COOKIE = 'mscd_session';
/** A password that meets the policy (F.4). */
export const PASSWORD = 'Correct-Horse-Battery-77';
/** Start of the mocked clock of every test file. */
export const T0 = new Date('2026-10-01T08:00:00.000Z');

// ---------------------------------------------------------------------------------------------------------------
// Mailpit (J.8)
// ---------------------------------------------------------------------------------------------------------------

export interface MailMessage {
  id: string;
  to: string[];
  subject: string;
  text: string;
  mailKind: string;
}

export interface Mailpit {
  host: string;
  smtpPort: number;
  /** Messages to `to` (all when omitted), oldest first. */
  messages(to?: string): Promise<MailMessage[]>;
  /** Waits until a message to `to` matching `predicate` exists and returns it. */
  waitFor(to: string, predicate?: (m: MailMessage) => boolean, timeoutMs?: number): Promise<MailMessage>;
  clear(): Promise<void>;
  stop(): Promise<void>;
}

const MAILPIT_IMAGE = 'axllent/mailpit:v1.31.3';

export async function startMailpit(): Promise<Mailpit> {
  const { GenericContainer, Wait } = await import('testcontainers');
  let container = new GenericContainer(MAILPIT_IMAGE)
    .withExposedPorts(1025, 8025)
    .withLabels({ 'mscd.test': 'true', 'mscd.test.expires': String(Date.now() + 3 * 3_600_000) })
    .withWaitStrategy(Wait.forListeningPorts());
  const prefix = process.env.MSCD_TEST_CONTAINER_PREFIX;
  if (prefix) container = container.withName(`${prefix}mailpit-${randomBytes(4).toString('hex')}`);
  const started = await container.start();
  const api = `http://${started.getHost()}:${started.getMappedPort(8025)}/api/v1`;

  const fetchJson = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${api}${path}`, init);
    if (!response.ok) throw new Error(`Mailpit ${path}: ${response.status}`);
    return response.status === 200 && response.headers.get('content-type')?.includes('json') ? response.json() : null;
  };
  const messages = async (to?: string): Promise<MailMessage[]> => {
    const list = (await fetchJson('/messages?limit=500')) as { messages: { ID: string; To: { Address: string }[]; Subject: string }[] };
    const wanted = list.messages.filter((m) => !to || m.To.some((a) => a.Address.toLowerCase() === to.toLowerCase())).reverse();
    return Promise.all(
      wanted.map(async (m) => {
        const full = (await fetchJson(`/message/${m.ID}`)) as { Text: string };
        const headers = (await fetchJson(`/message/${m.ID}/headers`)) as Record<string, string[]>;
        const kind = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-mscd-mail')?.[1]?.[0] ?? '';
        return { id: m.ID, to: m.To.map((a) => a.Address), subject: m.Subject, text: full.Text, mailKind: kind };
      }),
    );
  };
  return {
    host: started.getHost(),
    smtpPort: started.getMappedPort(1025),
    messages,
    async waitFor(to, predicate = () => true, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = (await messages(to)).find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`No email to ${to} arrived within ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    async clear() {
      await fetchJson('/messages', { method: 'DELETE' });
    },
    async stop() {
      await started.stop();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Clock and licence gate
// ---------------------------------------------------------------------------------------------------------------

/** A clock whose `now()` the test moves. */
export interface MutableClock {
  clock: Clock;
  now(): Date;
  set(at: Date): void;
  advance(ms: number): void;
}

export function mutableClock(config: ConstructorParameters<typeof Clock>[0], start = T0): MutableClock {
  let current = start.getTime();
  const clock = new Clock(config);
  clock.now = () => new Date(current);
  return {
    clock,
    now: () => new Date(current),
    set: (at) => {
      current = at.getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Licence gate that allows everything until a test sets `userLimitReached`. */
export class FakeLicenceGate implements LicenceGate {
  userLimitReached = false;
  readonly userChecks: string[] = [];

  async assertWritable(): Promise<void> {}

  async assertCanAddUser(_trx: unknown, orgId: string): Promise<void> {
    this.userChecks.push(orgId);
    if (this.userLimitReached) throw new BusinessRuleError('LIC-USERS', { en: 'The licence user limit is reached', id: 'Batas pengguna lisensi tercapai' });
  }

  async assertCanAddMs(): Promise<void> {}

  async assertFeature(): Promise<void> {}

  async isAdapterLicensed(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------------------------------------------

export interface IdentityApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  clock: MutableClock;
  licence: FakeLicenceGate;
  close(): Promise<void>;
}

/** The api modules the identity flows use, with a fake licence gate and a mutable clock. */
export async function createIdentityApp(
  db: TestDatabase,
  options: { mail?: Mailpit | null; env?: Record<string, string>; controllers?: Type<unknown>[] } = {},
): Promise<IdentityApp> {
  const env: Record<string, string> = { ...(options.env ?? {}) };
  if (options.mail) {
    env.MSCD__MAIL__SMTP__HOST = options.mail.host;
    env.MSCD__MAIL__SMTP__PORT = String(options.mail.smtpPort);
  } else {
    // No mail server: the mailer logs failures and never blocks a flow.
    env.MSCD__MAIL__SMTP__PORT ??= '9';
  }
  const config = db.config(env);
  const clock = mutableClock(config);
  const licence = new FakeLicenceGate();

  @Global()
  @Module({ providers: [{ provide: LICENCE_GATE, useValue: licence }], exports: [LICENCE_GATE] })
  class FakeLicenceModule {}

  const moduleRef = await db
    .createTestingModule({ controllers: options.controllers ?? [], imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, FakeLicenceModule] }, env)
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
// A client that keeps cookies
// ---------------------------------------------------------------------------------------------------------------

export interface CallOptions {
  /** `X-CSRF-Token`: the token of the last sign-in step (default), a given value, or none. */
  csrf?: string | false;
  /** `Origin` header; default the application's origin; null sends none. */
  origin?: string | null;
  headers?: Record<string, string>;
}

/** A browser: one cookie jar and the CSRF token of the latest sign-in step. */
export class Browser {
  readonly cookies = new Map<string, string>();
  csrfToken: string | null = null;

  constructor(private readonly app: NestFastifyApplication) {}

  get session(): string | undefined {
    return this.cookies.get(COOKIE);
  }

  async request(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, options: CallOptions = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') {
      const origin = options.origin === undefined ? APP_ORIGIN : options.origin;
      if (origin !== null) headers.origin = origin;
      const csrf = options.csrf === undefined ? this.csrfToken : options.csrf;
      if (csrf) headers['x-csrf-token'] = csrf;
    }
    const init: InjectOptions = { method, url, headers };
    if (body !== undefined) init.payload = body as InjectOptions['payload'];
    const response = await this.app.inject(init);
    for (const cookie of response.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
      const cleared = cookie.value === '' || cookie.maxAge === 0 || (cookie.expires !== undefined && cookie.expires.getTime() <= Date.now());
      if (cleared) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    const json = response.headers['content-type']?.toString().includes('json') ? (response.json() as { csrfToken?: unknown; me?: { csrfToken?: unknown } }) : null;
    if (json && typeof json.csrfToken === 'string') this.csrfToken = json.csrfToken;
    else if (json && typeof json.me?.csrfToken === 'string') this.csrfToken = json.me.csrfToken;
    return response;
  }

  post(url: string, body?: unknown, options?: CallOptions) {
    return this.request('POST', url, body, options);
  }

  put(url: string, body?: unknown, options?: CallOptions) {
    return this.request('PUT', url, body, options);
  }

  get(url: string, options?: CallOptions) {
    return this.request('GET', url, undefined, options);
  }

  login(email: string, password = PASSWORD, remember = false) {
    return this.post('/api/v1/auth/login', { email, password, remember });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

export interface TestUser {
  id: string;
  handle: string;
  email: string;
  /** TOTP secret of the confirmed factor, when the user has one. */
  secret: Buffer | null;
}

let passwordHash: Promise<string> | undefined;

/** A person with the test password, active memberships and optionally a confirmed TOTP factor. */
export async function addUser(
  db: TestDatabase,
  moduleRef: TestingModule,
  input: {
    handle: string;
    memberships: { org: CreatedTenant; adminRoles?: ('tenant_admin' | 'storage_admin')[]; isDefault?: boolean; status?: 'active' | 'invited' | 'disabled' }[];
    factor?: boolean;
    password?: string | null;
    status?: 'active' | 'invited' | 'disabled';
  },
): Promise<TestUser> {
  passwordHash ??= hashSecret(PASSWORD);
  const hash = input.password === null ? null : input.password ? await hashSecret(input.password) : await passwordHash;
  const email = `${input.handle}@identity.test`;
  const id = await inScope(db.migrator, { platformScope: true }, async (trx) => {
    const user = await trx
      .insertInto('platform.app_user')
      .values({ handle: input.handle, email, display_name: `User ${input.handle}`, password_hash: hash, status: input.status ?? 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [index, m] of input.memberships.entries()) {
      await trx
        .insertInto('platform.org_membership')
        .values({
          organization_id: m.org.id,
          user_id: user.id,
          admin_roles: m.adminRoles ?? [],
          is_default: m.isDefault ?? index === 0,
          status: m.status ?? 'active',
        })
        .execute();
    }
    return user.id;
  });
  const secret = input.factor ? await addFactor(db, moduleRef, id) : null;
  return { id, handle: input.handle, email, secret };
}

/** A confirmed TOTP factor for a user; returns its secret. */
export async function addFactor(db: TestDatabase, moduleRef: TestingModule, userId: string): Promise<Buffer> {
  const secret = newTotpSecret();
  const sealed = await moduleRef.get(SecretBox).seal(secret, { purpose: 'mfa', userId });
  await inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.insertInto('platform.mfa_factor').values({ user_id: userId, secret_sealed: sealed, confirmed_at: new Date() }).execute(),
  );
  return secret;
}

/** The TOTP code of a secret at the app's current (mocked) time, or `offsetSteps` steps away. */
export function codeAt(secret: Buffer, clock: MutableClock, offsetSteps = 0): string {
  return totpAt(secret, clock.now().getTime() + offsetSteps * 30_000);
}

/**
 * Forgets the route rate-limit buckets (fixed windows on the database clock, F.3), so tests do not share limits.
 * The per-session second-factor failure counters (`mfa-fail:` keys) are kept.
 */
export async function resetRateLimits(db: TestDatabase): Promise<void> {
  await sql`delete from platform.rate_limit_bucket where key not like 'mfa-fail:%'`.execute(db.migrator);
}

/** Platform audit actions written for a user (entity), oldest first. */
export async function auditActions(db: TestDatabase, userId: string): Promise<{ action: string; after: Record<string, unknown> | null; organization_id: string | null }[]> {
  return inScope(db.migrator, { platformScope: true }, (trx) =>
    trx
      .selectFrom('platform.audit_log')
      .select(['action', 'after_data as after', 'organization_id'])
      .where('entity_id', '=', userId)
      .orderBy('seq')
      .execute(),
  ) as Promise<{ action: string; after: Record<string, unknown> | null; organization_id: string | null }[]>;
}

/** Open (not revoked) sessions of a user. */
export async function openSessions(db: TestDatabase, userId: string) {
  return inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.session').selectAll().where('user_id', '=', userId).where('revoked_at', 'is', null).orderBy('created_at').execute(),
  );
}

/** The session row of a cookie value (revoked or not). */
export async function sessionRow(db: TestDatabase, cookieValue: string) {
  return inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.session').selectAll().where('id_hash', '=', sha256(cookieValue)).executeTakeFirstOrThrow(),
  );
}

/** Sets an organisation's status as the platform operator would and drops the resolver cache entry (F.7). */
export async function setOrgStatus(db: TestDatabase, moduleRef: TestingModule, orgId: string, status: 'active' | 'suspended' | 'offboarding' | 'archived'): Promise<void> {
  await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.organization').set({ status }).where('id', '=', orgId).execute());
  moduleRef.get(TenantResolver).invalidate(orgId);
}

/** Sets an organisation's local sign-in policy (F.4). */
export async function setLocalLogin(db: TestDatabase, moduleRef: TestingModule, orgId: string, policy: 'allowed' | 'admins_only' | 'disabled'): Promise<void> {
  await inScope(db.migrator, { platformScope: true }, (trx) => trx.updateTable('platform.organization').set({ local_login: policy }).where('id', '=', orgId).execute());
  moduleRef.get(TenantResolver).invalidate(orgId);
}

/** An enabled OIDC identity provider of an organisation. */
export async function addProvider(db: TestDatabase, orgId: string, slug: string, label: string): Promise<string> {
  return inScope(db.migrator, { platformScope: true }, async (trx) => {
    const row = await trx
      .insertInto('platform.identity_provider')
      .values({ organization_id: orgId, slug, kind: 'oidc', display_name: label, icon: 'microsoft', oidc_issuer: 'https://login.example.test/v2.0', oidc_client_id: 'mscd' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

/** A completed local sign-in with TOTP; returns the signed-in browser. */
export async function signIn(ctx: IdentityApp, user: TestUser, options: { remember?: boolean } = {}): Promise<Browser> {
  const browser = new Browser(ctx.app);
  const first = await browser.login(user.email, PASSWORD, options.remember ?? false);
  if (first.statusCode !== 200) throw new Error(`Sign-in of ${user.handle} failed: ${first.statusCode} ${first.body}`);
  if (!user.secret) throw new Error(`${user.handle} has no TOTP factor`);
  // Each sign-in uses a fresh step so earlier tests never make the code a replay.
  ctx.clock.advance(30_000);
  const second = await browser.post('/api/v1/auth/mfa/verify', { code: codeAt(user.secret, ctx.clock) });
  if (second.statusCode !== 200) throw new Error(`Second factor of ${user.handle} failed: ${second.statusCode} ${second.body}`);
  return browser;
}
