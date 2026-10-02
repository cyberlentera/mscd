// Helpers of the audit-side register tests (WP-37): an api application on a copy of the demo template with the real
// session resolver, authorisation, licence service, rule engine, the audit register commands and the
// `cycle.derive` job, a way to move the organisation's date (`demo.fixed_today` of the test profile), fixture rows
// in the framework content (`ref`, written as the pack installer: review inputs and cycle derivations that the demo
// packs do not carry), and fixture queries run as the migrator inside an organisation's schema. Sessions and
// requests reuse the client of the WP-20 command tests.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { CommandResult, Problem } from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import { Logger } from 'nestjs-pino';
import { Clock } from '../../../src/common/clock';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuditRegistersModule } from '../../../src/modules/audit-registers/audit-registers.module';
import { CycleDeriveJob } from '../../../src/modules/audit-registers/cycle-derive.job';
import type { CycleDeriveResult } from '../../../src/modules/audit-registers/cycle-derive.service';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { RulesModule } from '../../../src/modules/rules/rules.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import type { TestDatabase } from '../../setup/test-db';
import { inOrg, ORG_IDS, type DemoOrg } from '../commands-implementation/helpers';

export { auditOf, grantRole, inOrg, ORG_IDS, sessionFor, userId, verifyChain, type Client, type DemoOrg } from '../commands-implementation/helpers';

/** `demo.fixed_today` of the test profile. */
export const TODAY = '2026-09-29';

export type Reply = CommandResult & Problem;

export interface AuditApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  queue: InMemoryJobQueue;
  /** Moves the date every command and job sees (null: back to `demo.fixed_today`). */
  setToday(day: string | null): void;
  /** Runs `cycle.derive` for an organisation now (one system, or every system when `msId` is null). */
  derive(org: DemoOrg, msId?: string | null): Promise<CycleDeriveResult>;
  close(): Promise<void>;
}

/** The api modules of the audit register commands, on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createAuditApp(db: TestDatabase, env: Record<string, string> = {}): Promise<AuditApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      { imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, RulesModule, AuditRegistersModule] },
      settings,
    )
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const clock = moduleRef.get(Clock);
  let day: string | null = null;
  const fixed = Object.getOwnPropertyDescriptor(Clock.prototype, 'fixedToday')!.get!;
  Object.defineProperty(clock, 'fixedToday', { configurable: true, get: () => day ?? fixed.call(clock) });
  const job = moduleRef.get(CycleDeriveJob);
  return {
    app,
    moduleRef,
    queue: moduleRef.get(JOB_QUEUE) as InMemoryJobQueue,
    setToday(next) {
      day = next;
    },
    derive: (org, msId = null) => job.run(ORG_IDS[org], msId),
    close: () => app.close(),
  };
}

/** Rows of a query run as the migrator inside an organisation's schema. */
export function rowsOf<T>(db: TestDatabase, org: DemoOrg, query: RawBuilder<T>): Promise<T[]> {
  return inOrg(db, org, async (trx) => (await query.execute(trx)).rows);
}

/** Id and edition of a system by slug. */
export async function systemOf(db: TestDatabase, org: DemoOrg, ms: string): Promise<{ id: string; editionId: string }> {
  const [row] = await rowsOf<{ id: string; framework_version_id: string }>(db, org, sql`select id, framework_version_id from management_system where slug = ${ms}`);
  return { id: row!.id, editionId: row!.framework_version_id };
}

/** Fixture review input definitions of an edition (the demo packs define none). */
export async function addReviewInputs(db: TestDatabase, editionId: string, defs: { code: string; title: string; mandatory: boolean }[]): Promise<void> {
  for (const [index, def] of defs.entries()) {
    await sql`insert into ref.review_input_def (framework_version_id, code, title, mandatory, sort_order)
              values (${editionId}, ${def.code}, ${def.title}, ${def.mandatory}, ${index + 1})
              on conflict (framework_version_id, code) do nothing`.execute(db.packInstaller);
  }
}

/** Sets the derivation of a cycle requirement definition of an edition (the demo packs carry none, G.7). */
export async function setDerivation(db: TestDatabase, editionId: string, code: string, derivation: Record<string, unknown> | null): Promise<void> {
  await sql`update ref.cycle_requirement_def set derivation = ${derivation === null ? null : JSON.stringify(derivation)}::jsonb
             where framework_version_id = ${editionId} and code = ${code}`.execute(db.packInstaller);
}

/** Cycle items of a system with their definition code and status, in position order. */
export function cycleItemsOf(db: TestDatabase, org: DemoOrg, ms: string) {
  return rowsOf<{ id: string; def_code: string | null; title: string; status: string; cycle_start: string; cycle_end: string }>(
    db,
    org,
    sql`select s.id, d.code as def_code, s.title, s.status, c.cycle_start, c.cycle_end
          from cycle_requirement_status s
          join management_system m on m.id = s.management_system_id and m.slug = ${ms}
          join certification_cycle c on c.id = s.certification_cycle_id
          left join ref.cycle_requirement_def d on d.id = s.cycle_requirement_def_id
         where s.deleted_at is null order by s.position`,
  );
}

export const FINDINGS = (ms: string) => `/api/v1/ms/${ms}/findings`;
export const FINDING = (ms: string, id: string) => `/api/v1/ms/${ms}/findings/${id}`;
export const CAS = (ms: string) => `/api/v1/ms/${ms}/corrective-actions`;
export const CA = (ms: string, id: string) => `/api/v1/ms/${ms}/corrective-actions/${id}`;
export const SELF = (ms: string) => `/api/v1/ms/${ms}/self-assessments`;
export const REVIEWS = (ms: string) => `/api/v1/ms/${ms}/management-reviews`;
