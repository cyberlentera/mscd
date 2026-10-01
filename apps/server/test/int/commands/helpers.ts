// Helpers of the register, document, audit event and reminder command tests (WP-35): an api application on a copy
// of the demo template with the real session resolver, authorisation, licence service, rule engine, the WP-20 and
// WP-35 command modules and the `ui` and per-screen reads; sessions, clients and fixture queries come from the
// WP-20 helpers.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql, type RawBuilder } from 'kysely';
import { Logger } from 'nestjs-pino';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { ImplementationModule } from '../../../src/modules/implementation/implementation.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { ReadModelApiModule } from '../../../src/modules/read-model-api/read-model-api.module';
import { RegistersModule } from '../../../src/modules/registers/registers.module';
import { RemindersModule } from '../../../src/modules/reminders/reminders.module';
import { RulesModule } from '../../../src/modules/rules/rules.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { inOrg, type CommandsApp, type DemoOrg } from '../commands-implementation/helpers';

export {
  APP_ORIGIN, Client, COOKIE, ORG_IDS, auditOf, grantRole, inOrg, sessionFor, userId, verifyChain, type CommandsApp, type DemoOrg, type Reply,
} from '../commands-implementation/helpers';

export const TODAY = '2026-09-29';

/** The api modules the WP-35 commands need, on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createApp(db: TestDatabase, env: Record<string, string> = {}): Promise<CommandsApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      {
        imports: [
          TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, RulesModule, ImplementationModule, RegistersModule,
          RemindersModule, UiModule, ReadModelApiModule,
        ],
      },
      settings,
    )
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, moduleRef, queue: moduleRef.get(JOB_QUEUE) as InMemoryJobQueue, close: () => app.close() };
}

/** Rows of a query run as the migrator inside an organisation's schema. */
export function rowsOf<T>(db: TestDatabase, org: DemoOrg, query: RawBuilder<T>): Promise<T[]> {
  return inOrg(db, org, async (trx) => (await query.execute(trx)).rows);
}

/** Id of a system by slug. */
export async function msIdOf(db: TestDatabase, org: DemoOrg, ms: string): Promise<string> {
  const [row] = await rowsOf<{ id: string }>(db, org, sql`select id from management_system where slug = ${ms}`);
  return row!.id;
}

/** Notifications of a user, newest first. */
export function notificationsOf(db: TestDatabase, org: DemoOrg, handle: string, kind?: string) {
  return rowsOf<{ id: string; kind: string; title_en: string; body_en: string; body_id: string; digest: boolean }>(
    db,
    org,
    sql`select n.id, n.kind, n.title_en, n.body_en, n.body_id, n.digest from notification n join platform.app_user u on u.id = n.recipient_user_id
         where u.handle = ${handle} and (${kind ?? null}::text is null or n.kind = ${kind ?? null}) order by n.created_at desc, n.id`,
  );
}

export const RECORD_URL = (ms: string, entityType: string, id: string, action: 'assignment' | 'complete-action' | 'delete') =>
  `/api/v1/ms/${ms}/records/${entityType}/${id}/${action}`;
