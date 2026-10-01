// Helpers of the link health, integrity and drift job tests (WP-23): the mock providers with the demo fixtures
// (G.8), the storage gateway run mode pointed at them (and, for the re-hash, at a SeaweedFS vault), and an api
// application on a copy of the demo template with the job modules, the worker runtime on the in-memory queue (J.8),
// the real gateway client behind a scriptable wrapper, a settable clock and sessions for demo users.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { parseFixtureDocument, startMockProviders, type RunningMockProviders } from '@mscd/mock-providers';
import type { CommandResult, JobName, Problem } from '@mscd/shared';
import type { InjectOptions } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { Logger } from 'nestjs-pino';
import { Clock } from '../../../src/common/clock';
import { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { JOB_QUEUE, type JobEnvelope, type JobPayloads, type SendOptions } from '../../../src/common/jobs/job-queue';
import { GATEWAY_CLIENT, type GatewayClient } from '../../../src/common/tokens';
import type { DB } from '../../../src/db/types';
import { m365AdapterFactory } from '../../../src/gateway/adapters/m365';
import { googleDriveAdapterFactory } from '../../../src/gateway/adapters/google-drive';
import { managedVaultAdapterFactory } from '../../../src/gateway/adapters/managed-vault/vault-adapter';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { DriftModule } from '../../../src/modules/drift/drift.module';
import { FreshnessModule } from '../../../src/modules/freshness/freshness.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { SessionService } from '../../../src/modules/identity/session.service';
import { IntegrityModule } from '../../../src/modules/integrity/integrity.module';
import { JobsModule } from '../../../src/modules/jobs/jobs.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { LinkHealthModule } from '../../../src/modules/link-health/link-health.module';
import { RequestPacer } from '../../../src/modules/link-health/request-pacer';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { HttpGatewayClient } from '../../../src/modules/storage/gateway-client';
import { StorageModule } from '../../../src/modules/storage/storage.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { UiModule } from '../../../src/modules/ui/ui.module';
import { WorkerRuntime } from '../../../src/worker/worker-runtime';
import { WorkerRuntimeModule } from '../../../src/worker/worker-runtime.module';
import type { TestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { gatewayConfig, startGateway, type RunningGateway } from '../gateway/helpers';
import { JOB_TEST_ENV } from '../jobs/helpers';

export const COOKIE = 'mscd_session';
export const APP_ORIGIN = 'http://localhost:4174';

/** Fixed ids of the demo organisations (G.3). */
export const ORG_IDS = {
  ndt: '00000000-0000-4000-8000-00000000a001',
  bsd: '00000000-0000-4000-8000-00000000a002',
  rmn: '00000000-0000-4000-8000-00000000a003',
  tst: '00000000-0000-4000-8000-00000000a004',
} as const;
export type DemoOrg = keyof typeof ORG_IDS;

/** 2026-09-29 12:00 in Jakarta: `demo.fixed_today` at noon, the instant most tests run at. */
export const NOON = '2026-09-29T05:00:00Z';

export const DEMO_FIXTURES = path.resolve(__dirname, '../../../../../tools/mock-providers/fixtures/demo.json');

/** The demo fixture document of the mock providers (G.8). */
export function demoFixtures(): unknown {
  return parseFixtureDocument(JSON.parse(readFileSync(DEMO_FIXTURES, 'utf8')));
}

export interface ProviderStack {
  mock: RunningMockProviders;
  gateway: RunningGateway;
  close(): Promise<void>;
}

/** The mock providers with the demo fixtures and the storage gateway pointed at them (and at `vaultEndpoint`). */
export async function startProviderStack(options: { vaultEndpoint?: string } = {}): Promise<ProviderStack> {
  const mock = await startMockProviders({ port: 0, fixtures: demoFixtures() });
  const config = gatewayConfig({
    MSCD__GATEWAY__PROVIDERS__M365__GRAPH_BASE_URL: `${mock.url}/v1.0`,
    MSCD__GATEWAY__PROVIDERS__M365__LOGIN_BASE_URL: mock.url,
    MSCD__GATEWAY__PROVIDERS__GOOGLE__API_BASE_URL: mock.url,
    MSCD__GATEWAY__PROVIDERS__GOOGLE__TOKEN_URL: `${mock.url}/token`,
    // Without a vault container the vault endpoint is a closed port: vault calls answer `unreachable`.
    MSCD__GATEWAY__VAULT__ENDPOINT: options.vaultEndpoint ?? 'http://127.0.0.1:9',
  });
  const gateway = await startGateway(config, { factories: [managedVaultAdapterFactory, m365AdapterFactory, googleDriveAdapterFactory] });
  return {
    mock,
    gateway,
    close: async () => {
      await gateway.close();
      await mock.close();
    },
  };
}

/** Calls the mock's admin API (fault switches, J.7). */
export async function mockAdmin<T = Record<string, unknown>>(mock: RunningMockProviders, pathName: string, body?: unknown): Promise<T> {
  const response = await fetch(`${mock.url}${pathName}`, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`mock ${pathName} answered ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * The gateway client of the tests: the real HTTP client of the api, with an optional script that answers a call
 * instead (a value) or lets it through (undefined), and a log of the calls.
 */
export class ScriptedGateway implements GatewayClient {
  readonly calls: { path: string; body: unknown }[] = [];
  script: ((pathName: string, body: unknown) => unknown) | null = null;

  constructor(private readonly real: GatewayClient) {}

  async post<T>(pathName: string, body: unknown, options?: { requestId?: string; signal?: AbortSignal }): Promise<T> {
    this.calls.push({ path: pathName, body });
    if (this.script) {
      const answer = this.script(pathName, body);
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return answer as T;
    }
    return this.real.post<T>(pathName, body, options);
  }

  putObject<T>(...args: Parameters<GatewayClient['putObject']>): Promise<T> {
    return this.real.putObject<T>(...args);
  }

  stream(...args: Parameters<GatewayClient['stream']>) {
    return this.real.stream(...args);
  }
}

export interface HealthApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  queue: InMemoryJobQueue;
  gateway: ScriptedGateway;
  /** Sets the instant `Clock.now()` returns (null: the real time). */
  setNow(at: Date | string | null): void;
  /** Sends a job and runs the worker in process until idle (delayed jobs too unless `delayed: false`). */
  run<N extends JobName>(name: N, env: JobEnvelope<JobPayloads[N]>, opts?: SendOptions & { delayed?: boolean }): Promise<void>;
  drain(includeDelayed?: boolean): Promise<void>;
  close(): Promise<void>;
}

/** An api application with the WP-23 job modules and the worker runtime on the in-memory queue. */
export async function createHealthApp(db: TestDatabase, stack: ProviderStack, env: Record<string, string> = {}): Promise<HealthApp> {
  const settings: Record<string, string> = { ...JOB_TEST_ENV, MSCD__MAIL__SMTP__PORT: '9', MSCD__STORAGE__GATEWAY__URL: stack.gateway.url, ...env };
  const config = db.config(settings);
  const gateway = new ScriptedGateway(new HttpGatewayClient(config));
  const moduleRef = await db
    .createTestingModule(
      {
        imports: [
          TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, UiModule,
          JobsModule, WorkerRuntimeModule, StorageModule, FreshnessModule, LinkHealthModule, IntegrityModule, DriftModule,
        ],
      },
      settings,
    )
    .overrideProvider(GATEWAY_CLIENT)
    .useValue(gateway)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const queue = moduleRef.get<InMemoryJobQueue>(JOB_QUEUE);
  if (!(queue instanceof InMemoryJobQueue)) throw new Error('The job tests expect the in-memory queue of the test profile');
  const clock = moduleRef.get(Clock);
  let fixed: Date | null = new Date(NOON);
  clock.now = () => (fixed ? new Date(fixed.getTime()) : new Date());
  // The token bucket is covered by its own test; elsewhere it must not slow the suite down.
  const pacer = moduleRef.get(RequestPacer);
  pacer.rates = { m365: 10_000, google_drive: 10_000, managed_vault: 10_000, smb: 10_000, s3: 10_000, webdav: 10_000 };
  await moduleRef.get(WorkerRuntime).start();
  return {
    app,
    moduleRef,
    queue,
    gateway,
    setNow(at) {
      fixed = at === null ? null : new Date(at);
    },
    async run(name, env, opts = {}) {
      const { delayed, ...send } = opts;
      await queue.send(name, env, send);
      await queue.drain({ includeDelayed: delayed !== false });
    },
    drain: (includeDelayed = true) => queue.drain({ includeDelayed }),
    close: () => app.close(),
  };
}

/** Runs `fn` as the migrator inside an organisation's schema (fixtures and assertions, RLS applies). */
export function inOrg<T>(db: TestDatabase, org: DemoOrg, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return inScope(db.migrator, { orgId: ORG_IDS[org], schema: `org_${org}` }, fn);
}

/** Rows of a query run inside an organisation's schema. */
export async function rows<T>(db: TestDatabase, org: DemoOrg, query: ReturnType<typeof sql<T>>): Promise<T[]> {
  return inOrg(db, org, async (trx) => (await query.execute(trx)).rows);
}

/** A demo user's id by handle. */
export async function userId(db: TestDatabase, handle: string): Promise<string> {
  const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.app_user').select('id').where('handle', '=', handle).executeTakeFirstOrThrow(),
  );
  return row.id;
}

export interface Reply<T> {
  status: number;
  body: T;
}

/** A client signed in as a demo user (session written through `SessionService`). */
export class Client {
  constructor(
    private readonly app: NestFastifyApplication,
    private readonly cookie: string,
    private readonly csrf: string,
  ) {}

  async request<T = CommandResult & Problem>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<Reply<T>> {
    const headers: Record<string, string> = { cookie: `${COOKIE}=${this.cookie}` };
    if (method !== 'GET') {
      headers.origin = APP_ORIGIN;
      headers['x-csrf-token'] = this.csrf;
    }
    const init: InjectOptions = { method, url, headers };
    if (body !== undefined) init.payload = body as InjectOptions['payload'];
    const response = await this.app.inject(init);
    return { status: response.statusCode, body: (response.body ? response.json() : undefined) as T };
  }

  get<T = unknown>(url: string) {
    return this.request<T>('GET', url);
  }

  post(url: string, body?: unknown) {
    return this.request('POST', url, body);
  }
}

export async function sessionFor(ctx: HealthApp, db: TestDatabase, handle: string, org: DemoOrg): Promise<Client> {
  const id = await userId(db, handle);
  const sessions = ctx.moduleRef.get(SessionService);
  const scope = ctx.moduleRef.get(TenantScope);
  const orgId = ORG_IDS[org];
  const issued = await scope.withTenant({ orgId, schema: `org_${org}`, userId: id }, (trx) => {
    const now = new Date();
    return sessions.create(trx, {
      userId: id,
      organizationId: orgId,
      authOrgId: orgId,
      state: 'active',
      authMethod: 'local',
      identityProviderId: null,
      authGrantId: null,
      passwordAt: now,
      mfaAt: now,
    });
  });
  return new Client(ctx.app, issued.cookieValue, issued.csrfToken);
}

/** The storage object of an evidence or document code in a demo organisation. */
export interface ObjectState {
  id: string;
  repository: string;
  external_item_id: string;
  link_status: string;
  link_status_reason: string | null;
  link_status_since: Date;
  last_verified_at: Date | null;
  last_good_check_at: Date | null;
  folder_path: string | null;
}

export async function evidenceObject(db: TestDatabase, org: DemoOrg, code: string): Promise<ObjectState & { evidence_id: string }> {
  const found = await rows<ObjectState & { evidence_id: string }>(
    db,
    org,
    sql`SELECT o.id, r.slug AS repository, o.external_item_id, o.link_status, o.link_status_reason, o.link_status_since,
               o.last_verified_at, o.last_good_check_at, o.folder_path, e.id AS evidence_id
        FROM evidence e JOIN storage_object o ON o.id = e.storage_object_id JOIN storage_repository r ON r.id = o.storage_repository_id
        WHERE e.evidence_code = ${code} AND e.deleted_at IS NULL`,
  );
  if (found.length !== 1) throw new Error(`${org}: evidence ${code} has ${found.length} storage objects`);
  return found[0]!;
}

export async function objectState(db: TestDatabase, org: DemoOrg, id: string): Promise<ObjectState> {
  const found = await rows<ObjectState>(
    db,
    org,
    sql`SELECT o.id, r.slug AS repository, o.external_item_id, o.link_status, o.link_status_reason, o.link_status_since,
               o.last_verified_at, o.last_good_check_at, o.folder_path
        FROM storage_object o JOIN storage_repository r ON r.id = o.storage_repository_id WHERE o.id = ${id}::uuid`,
  );
  return found[0]!;
}

/** Link statuses of every storage object of an organisation, by id. */
export async function allStatuses(db: TestDatabase, org: DemoOrg): Promise<Record<string, string>> {
  const list = await rows<{ id: string; link_status: string; link_status_reason: string | null }>(
    db,
    org,
    sql`SELECT id, link_status, link_status_reason FROM storage_object WHERE deleted_at IS NULL ORDER BY id`,
  );
  return Object.fromEntries(list.map((r) => [r.id, `${r.link_status}${r.link_status_reason ? `/${r.link_status_reason}` : ''}`]));
}

/** The repository id of a slug. */
export async function repositoryId(db: TestDatabase, org: DemoOrg, slug: string): Promise<string> {
  const found = await rows<{ id: string }>(db, org, sql`SELECT id FROM storage_repository WHERE slug = ${slug} AND deleted_at IS NULL`);
  return found[0]!.id;
}
