// Helpers of the file command tests (WP-21): the demo template with a storage gateway on SeaweedFS and the mock
// providers loaded with the demo fixture (G.8), an api application with the real session resolver, authorisation,
// licence service, storage and files modules (plus `ui` for the parity checks), and clients signed in as demo users
// with their CSRF token.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startMockProviders, type RunningMockProviders } from '@mscd/mock-providers';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { Logger } from 'nestjs-pino';
import { JOB_QUEUE, type JobQueue } from '../../../src/common/tokens';
import type { Trx } from '../../../src/common/tokens';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { FilesModule } from '../../../src/modules/files/files.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { SessionService } from '../../../src/modules/identity/session.service';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { StorageModule } from '../../../src/modules/storage/storage.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { gatewayConfig, startGateway, startSeaweed, vaultEnv, type RunningGateway, type Seaweed } from '../gateway/helpers';
import { ORG_IDS, type DemoOrg } from '../read-model/helpers';

export { ORG_IDS, type DemoOrg };
export const COOKIE = 'mscd_session';
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
export const DEMO_FIXTURE_FILE = path.join(REPO_ROOT, 'tools/mock-providers/fixtures/demo.json');

/** The storage side of the tests: SeaweedFS, the mock providers with the demo fixture, and a storage gateway. */
export interface StorageStack {
  seaweed: Seaweed;
  mock: RunningMockProviders;
  gateway: RunningGateway;
  close(): Promise<void>;
}

export async function startStorageStack(): Promise<StorageStack> {
  const seaweed = await startSeaweed();
  const mock = await startMockProviders({ port: 0, fixtures: JSON.parse(readFileSync(DEMO_FIXTURE_FILE, 'utf8')) as unknown });
  const gateway = await startGateway(
    gatewayConfig({
      ...vaultEnv(seaweed),
      MSCD__GATEWAY__PROVIDERS__M365__GRAPH_BASE_URL: `${mock.url}/v1.0`,
      MSCD__GATEWAY__PROVIDERS__M365__LOGIN_BASE_URL: mock.url,
      MSCD__GATEWAY__PROVIDERS__GOOGLE__API_BASE_URL: mock.url,
      MSCD__GATEWAY__PROVIDERS__GOOGLE__TOKEN_URL: `${mock.url}/token`,
    }),
  );
  return {
    seaweed,
    mock,
    gateway,
    close: async () => {
      await gateway.close().catch(() => undefined);
      await mock.close().catch(() => undefined);
      await seaweed.stop().catch(() => undefined);
    },
  };
}

export interface FilesApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  jobs: JobQueue;
  close(): Promise<void>;
}

/** The api modules of the file routes on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createFilesApp(db: TestDatabase, gatewayUrl: string, env: Record<string, string> = {}): Promise<FilesApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', MSCD__STORAGE__GATEWAY__URL: gatewayUrl, ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      { imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, StorageModule, FilesModule, UiModule] },
      settings,
    )
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, moduleRef, jobs: moduleRef.get<JobQueue>(JOB_QUEUE), close: () => app.close() };
}

/** A user's id by handle. */
export async function userId(db: TestDatabase, handle: string): Promise<string> {
  const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.app_user').select('id').where('handle', '=', handle).executeTakeFirstOrThrow(),
  );
  return row.id;
}

export interface Answer<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: T;
  raw: Buffer;
}

/** A client with one session cookie and its CSRF token. */
export class FilesClient {
  constructor(
    private readonly app: NestFastifyApplication,
    readonly cookie: string,
    readonly csrf: string,
    readonly userId: string,
  ) {}

  async call<T = unknown>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Answer<T>> {
    const init: InjectOptions = {
      method,
      url,
      headers: { cookie: `${COOKIE}=${this.cookie}`, ...(method === 'GET' ? {} : { 'x-csrf-token': this.csrf }), ...headers },
    };
    if (Buffer.isBuffer(payload)) {
      init.payload = payload;
      init.headers = { 'content-type': 'application/octet-stream', ...init.headers };
    } else if (payload !== undefined) {
      init.payload = payload as Record<string, unknown>;
    }
    const response = await this.app.inject(init);
    const raw = response.rawPayload;
    const type = String(response.headers['content-type'] ?? '');
    const body = type.includes('json') && raw.length > 0 ? (JSON.parse(raw.toString('utf8')) as T) : (undefined as T);
    return { status: response.statusCode, headers: response.headers, body, raw };
  }

  get<T = unknown>(url: string): Promise<Answer<T>> {
    return this.call<T>('GET', url);
  }

  post<T = unknown>(url: string, payload: unknown, headers?: Record<string, string>): Promise<Answer<T>> {
    return this.call<T>('POST', url, payload, headers);
  }

  put<T = unknown>(url: string, payload: Buffer, headers?: Record<string, string>): Promise<Answer<T>> {
    return this.call<T>('PUT', url, payload, headers);
  }
}

/** A client signed in as a user in an organisation (session written through `SessionService`). */
export async function signIn(ctx: FilesApp, db: TestDatabase, handle: string, org: DemoOrg): Promise<FilesClient> {
  const id = await userId(db, handle);
  const kind = await inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.app_user').select('kind').where('id', '=', id).executeTakeFirstOrThrow(),
  );
  const sessions = ctx.moduleRef.get(SessionService);
  const scope = ctx.moduleRef.get(TenantScope);
  const orgId = ORG_IDS[org];
  const issued = await scope.withTenant({ orgId, schema: `org_${org}`, userId: id }, async (trx) => {
    const now = new Date();
    const grant = kind.kind === 'guest' ? await grantOf(trx, id) : null;
    return sessions.create(trx, {
      userId: id,
      organizationId: orgId,
      authOrgId: orgId,
      state: 'active',
      authMethod: kind.kind === 'guest' ? 'guest' : 'local',
      identityProviderId: null,
      authGrantId: grant,
      passwordAt: now,
      mfaAt: now,
    });
  });
  return new FilesClient(ctx.app, issued.cookieValue, issued.csrfToken, id);
}

async function grantOf(trx: Trx, user: string): Promise<string | null> {
  const row = await sql<{ id: string }>`select id from auditor_access_grant where user_id = ${user}::uuid and revoked_at is null limit 1`.execute(trx);
  return row.rows[0]?.id ?? null;
}

/** Runs `fn` in a migrator transaction scoped to a demo organisation. */
export function inOrg<T>(db: TestDatabase, org: DemoOrg, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return inScope(db.migrator, { orgId: ORG_IDS[org], schema: `org_${org}` }, fn);
}

/** A call to the mock providers' admin API (J.7). */
export async function mockAdmin<T = Record<string, unknown>>(mock: RunningMockProviders, pathName: string, body?: unknown): Promise<T> {
  const response = await fetch(`${mock.url}${pathName}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`mock admin ${pathName}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}
