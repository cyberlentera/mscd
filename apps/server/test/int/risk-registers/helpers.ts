// Helpers of the risk-side register tests (WP-36): an api application on a copy of the demo template with the real
// session resolver, authorisation, licence service, rule engine, the risk register commands, WP-35's record
// commands (generic soft delete), the `ui` reads and the freshness service (E.3), plus fixture queries run as the
// migrator inside the organisation's schema. Sessions and requests reuse the client of the WP-20 command tests.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { CommandResult, Page, Problem, RegisterItem } from '@mscd/shared';
import { sql } from 'kysely';
import { Logger } from 'nestjs-pino';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { FreshnessModule } from '../../../src/modules/freshness/freshness.module';
import { FreshnessService } from '../../../src/modules/freshness/freshness.service';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { RegistersModule } from '../../../src/modules/registers/registers.module';
import { RiskRegistersModule } from '../../../src/modules/risk-registers/risk-registers.module';
import { RulesModule } from '../../../src/modules/rules/rules.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { inOrg, ORG_IDS, type DemoOrg } from '../commands-implementation/helpers';

export { auditOf, grantRole, inOrg, ORG_IDS, sessionFor, userId, verifyChain, type Client, type DemoOrg } from '../commands-implementation/helpers';

export interface RiskApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  queue: InMemoryJobQueue;
  /** Runs `freshness.recompute` for a system of an organisation now (the job's work, E.3). */
  recompute(org: DemoOrg, scope: { msId?: string; evidenceIds?: string[]; entryIds?: string[] }): Promise<void>;
  close(): Promise<void>;
}

/** The api modules of the risk register commands, on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createRiskApp(db: TestDatabase, env: Record<string, string> = {}): Promise<RiskApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      {
        imports: [
          TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, RulesModule, RiskRegistersModule, RegistersModule,
          UiModule, FreshnessModule,
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
  const freshness = moduleRef.get(FreshnessService);
  const tenants = moduleRef.get(TenantResolver);
  return {
    app,
    moduleRef,
    queue: moduleRef.get(JOB_QUEUE) as InMemoryJobQueue,
    async recompute(org, scope) {
      const tenant = await tenants.require(ORG_IDS[org]);
      await freshness.recompute(tenant, scope);
    },
    close: () => app.close(),
  };
}

export type Reply = CommandResult & Problem;
export type RegisterPage = Page<RegisterItem>;

/** A register row's id, owner and pending action by table and code. */
export async function rowOf(
  db: TestDatabase,
  org: DemoOrg,
  table: string,
  code: string,
): Promise<{ id: string; owner: string | null; pending: string | null; updatedAt: Date; row: Record<string, unknown> }> {
  return inOrg(db, org, async (trx) => {
    const codeColumn = table === 'evidence' ? 'evidence_code' : table === 'document' ? 'doc_code' : 'code';
    const { rows } = await sql<Record<string, unknown> & { id: string; owner: string | null; updated_at: Date }>`
      select t.*, (select handle from platform.app_user u where u.id = t.owner_user_id) as owner
        from ${sql.table(table)} t where t.${sql.ref(codeColumn)} = ${code} and t.deleted_at is null`.execute(trx);
    const r = rows[0];
    if (!r) throw new Error(`No ${table} ${code} in ${org}`);
    return { id: r.id, owner: r.owner, pending: (r.pending_action as string | null) ?? null, updatedAt: r.updated_at, row: r };
  });
}

/** The live links of a shareable record: system slugs, primary first. */
export async function linksOf(db: TestDatabase, org: DemoOrg, entityType: string, entityId: string): Promise<{ id: string; slug: string; primary: boolean }[]> {
  return inOrg(db, org, async (trx) => {
    const { rows } = await sql<{ id: string; slug: string; primary: boolean }>`
      select l.id, m.slug, l.is_primary as primary from entity_ms_link l join management_system m on m.id = l.management_system_id
       where l.entity_type = ${entityType} and l.entity_id = ${entityId} and l.deleted_at is null order by l.is_primary desc, m.slug`.execute(trx);
    return rows;
  });
}

/** `management_system.id` by slug. */
export async function msIdOf(db: TestDatabase, org: DemoOrg, slug: string): Promise<string> {
  return inOrg(db, org, async (trx) => {
    const row = await trx.selectFrom('management_system').select('id').where('slug', '=', slug).executeTakeFirstOrThrow();
    return row.id;
  });
}

export const REGISTERS_URL = (ms: string, register: string) => `/api/v1/ms/${ms}/registers/${register}`;
