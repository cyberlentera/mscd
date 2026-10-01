// Helpers of the read model and parity integration tests (WP-17): an api application on a copy of the demo template
// with the real session resolver, authorisation, licence service and the `ui` routes, and sessions for the demo
// users written directly through `SessionService` (no sign-in flow).
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { Logger } from 'nestjs-pino';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { SessionService } from '../../../src/modules/identity/session.service';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';

export const COOKIE = 'mscd_session';

/** Fixed ids of the demo organisations (G.3). */
export const ORG_IDS = {
  ndt: '00000000-0000-4000-8000-00000000a001',
  bsd: '00000000-0000-4000-8000-00000000a002',
  rmn: '00000000-0000-4000-8000-00000000a003',
  tst: '00000000-0000-4000-8000-00000000a004',
} as const;
export type DemoOrg = keyof typeof ORG_IDS;

export interface ReadModelApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  close(): Promise<void>;
}

/** The api modules the UI parity reads need, on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createReadModelApp(db: TestDatabase, env: Record<string, string> = {}): Promise<ReadModelApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule({ imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, UiModule] }, settings)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, moduleRef, close: () => app.close() };
}

/** A demo user's id by handle. */
export async function userId(db: TestDatabase, handle: string): Promise<string> {
  const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.app_user').select('id').where('handle', '=', handle).executeTakeFirstOrThrow(),
  );
  return row.id;
}

/** A client signed in as a demo user in an organisation, with a session written through `SessionService`. */
export async function sessionFor(ctx: ReadModelApp, db: TestDatabase, handle: string, org: DemoOrg): Promise<UiClient> {
  const id = await userId(db, handle);
  const kind = await inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.app_user').select('kind').where('id', '=', id).executeTakeFirstOrThrow(),
  );
  const sessions = ctx.moduleRef.get(SessionService);
  const scope = ctx.moduleRef.get(TenantScope);
  const orgId = ORG_IDS[org];
  const issued = await scope.withTenant({ orgId, schema: `org_${org}`, userId: id }, async (trx) => {
    const now = new Date();
    return sessions.create(trx, {
      userId: id,
      organizationId: orgId,
      authOrgId: orgId,
      state: 'active',
      authMethod: kind.kind === 'guest' ? 'guest' : 'local',
      identityProviderId: null,
      authGrantId: kind.kind === 'guest' ? await grantOf(trx, id) : null,
      passwordAt: now,
      mfaAt: now,
    });
  });
  return new UiClient(ctx.app, issued.cookieValue);
}

async function grantOf(trx: Parameters<Parameters<TenantScope['withTenant']>[1]>[0], user: string): Promise<string | null> {
  const row = await sql<{ id: string }>`select id from auditor_access_grant where user_id = ${user}::uuid and revoked_at is null limit 1`.execute(trx);
  return row.rows[0]?.id ?? null;
}

export interface UiResponse<T> {
  status: number;
  body: T;
  ms: number;
}

/** A client with one session cookie. */
export class UiClient {
  constructor(
    private readonly app: NestFastifyApplication,
    private readonly cookie: string,
  ) {}

  async get<T = unknown>(url: string): Promise<UiResponse<T>> {
    const init: InjectOptions = { method: 'GET', url, headers: { cookie: `${COOKIE}=${this.cookie}` } };
    const started = performance.now();
    const response = await this.app.inject(init);
    const ms = performance.now() - started;
    return { status: response.statusCode, body: response.body ? (response.json() as T) : (undefined as T), ms };
  }
}
