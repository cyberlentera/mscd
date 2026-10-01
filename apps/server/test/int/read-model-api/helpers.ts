// Helpers of the per-screen read endpoint tests (WP-32): an api application on a copy of the demo template with the
// `ui` routes (for the TS 9.6 comparison with `GET /ui/ms/{ms}`) and the `read-model-api` routes, and clients with a
// session of a demo user (written through `SessionService`, as the WP-17 helpers do).
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { sql } from 'kysely';
import { Logger } from 'nestjs-pino';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { SessionService } from '../../../src/modules/identity/session.service';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { ReadModelApiModule } from '../../../src/modules/read-model-api/read-model-api.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { COOKIE, ORG_IDS, userId, type DemoOrg, type ReadModelApp } from '../read-model/helpers';

export { ORG_IDS, userId, type DemoOrg, type ReadModelApp } from '../read-model/helpers';

/** The api modules of the per-screen endpoints on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createScreenApp(db: TestDatabase): Promise<ReadModelApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9' };
  const config = db.config(settings);
  const moduleRef: TestingModule = await db
    .createTestingModule(
      { imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, UiModule, ReadModelApiModule] },
      settings,
    )
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, moduleRef, close: () => app.close() };
}

export interface ApiResponse<T> {
  status: number;
  body: T;
}

/** A client with one session cookie and an optional `Accept-Language`. */
export class ScreenClient {
  constructor(
    private readonly app: NestFastifyApplication,
    private readonly cookie: string,
  ) {}

  async get<T = unknown>(url: string, language?: string): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { cookie: `${COOKIE}=${this.cookie}` };
    if (language) headers['accept-language'] = language;
    const response = await this.app.inject({ method: 'GET', url, headers });
    return { status: response.statusCode, body: response.body ? (response.json() as T) : (undefined as T) };
  }

  /** Every page of a `Page<T>` list (pages of `pageSize`). */
  async all<T>(url: string, pageSize = 200): Promise<{ items: T[]; total: number }> {
    const items: T[] = [];
    let total = 0;
    for (let page = 1; ; page += 1) {
      const sep = url.includes('?') ? '&' : '?';
      const response = await this.get<{ items: T[]; total: number }>(`${url}${sep}page=${page}&pageSize=${pageSize}`);
      if (response.status !== 200) throw new Error(`${url}: ${response.status} ${JSON.stringify(response.body)}`);
      items.push(...response.body.items);
      total = response.body.total;
      if (items.length >= total || response.body.items.length === 0) break;
    }
    return { items, total };
  }
}

/** A client signed in as a demo user in an organisation, with a session written through `SessionService`. */
export async function screenClient(ctx: ReadModelApp, db: TestDatabase, handle: string, org: DemoOrg): Promise<ScreenClient> {
  const id = await userId(db, handle);
  const { kind } = await inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.app_user').select('kind').where('id', '=', id).executeTakeFirstOrThrow(),
  );
  const orgId = ORG_IDS[org];
  const sessions = ctx.moduleRef.get(SessionService);
  const issued = await ctx.moduleRef.get(TenantScope).withTenant({ orgId, schema: `org_${org}`, userId: id }, async (trx) => {
    const grant = kind === 'guest'
      ? ((await sql<{ id: string }>`select id from auditor_access_grant where user_id = ${id}::uuid and revoked_at is null limit 1`.execute(trx)).rows[0]?.id ?? null)
      : null;
    const now = new Date();
    return sessions.create(trx, {
      userId: id,
      organizationId: orgId,
      authOrgId: orgId,
      state: 'active',
      authMethod: kind === 'guest' ? 'guest' : 'local',
      identityProviderId: null,
      authGrantId: grant,
      passwordAt: now,
      mfaAt: now,
    });
  });
  return new ScreenClient(ctx.app, issued.cookieValue);
}
