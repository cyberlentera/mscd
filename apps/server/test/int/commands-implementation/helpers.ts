// Helpers of the implementation command tests (WP-20): an api application on a copy of the demo template with the
// real session resolver, authorisation, licence service, rule engine, the implementation commands and the `ui`
// reads; sessions for demo users written through `SessionService` (cookie and CSRF token); fixture queries run as
// the migrator inside the organisation's schema.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { CommandResult, Problem, UiMsSnapshot } from '@mscd/shared';
import type { InjectOptions } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { Logger } from 'nestjs-pino';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import type { DB } from '../../../src/db/types';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { SessionService } from '../../../src/modules/identity/session.service';
import { ImplementationModule } from '../../../src/modules/implementation/implementation.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { RulesModule } from '../../../src/modules/rules/rules.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { UiModule } from '../../../src/modules/ui/ui.module';
import type { TestDatabase } from '../../setup/test-db';
import { chainVerificationQuery, inScope } from '../db/helpers';

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

export interface CommandsApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  queue: InMemoryJobQueue;
  close(): Promise<void>;
}

/** The api modules the implementation commands need, on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createCommandsApp(db: TestDatabase, env: Record<string, string> = {}): Promise<CommandsApp> {
  const settings = { MSCD__MAIL__SMTP__PORT: '9', ...env };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      { imports: [TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, RulesModule, ImplementationModule, UiModule] },
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

/** Runs `fn` as the migrator inside an organisation's schema (fixtures and assertions). */
export function inOrg<T>(db: TestDatabase, org: DemoOrg, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return inScope(db.migrator, { orgId: ORG_IDS[org], schema: `org_${org}` }, fn);
}

/** A demo user's id by handle. */
export async function userId(db: TestDatabase, handle: string): Promise<string> {
  const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.selectFrom('platform.app_user').select('id').where('handle', '=', handle).executeTakeFirstOrThrow(),
  );
  return row.id;
}

/** A client signed in as a demo user in an organisation (session written through `SessionService`). */
export async function sessionFor(ctx: CommandsApp, db: TestDatabase, handle: string, org: DemoOrg): Promise<Client> {
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
  return new Client(ctx.app, issued.cookieValue, issued.csrfToken, handle);
}

export interface Reply<T> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
}

/** A client with one session cookie and its CSRF token. */
export class Client {
  constructor(
    private readonly app: NestFastifyApplication,
    private readonly cookie: string,
    private readonly csrf: string,
    readonly handle: string,
  ) {}

  async request<T = CommandResult & Problem>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
    const all: Record<string, string> = { cookie: `${COOKIE}=${this.cookie}`, ...headers };
    if (method !== 'GET') {
      all.origin = APP_ORIGIN;
      all['x-csrf-token'] = this.csrf;
    }
    const init: InjectOptions = { method, url, headers: all };
    if (body !== undefined) init.payload = body as InjectOptions['payload'];
    const response = await this.app.inject(init);
    return { status: response.statusCode, body: (response.body ? response.json() : undefined) as T, headers: response.headers };
  }

  get<T = unknown>(url: string) {
    return this.request<T>('GET', url);
  }

  post(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request('POST', url, body, headers);
  }

  patch(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request('PATCH', url, body, headers);
  }

  snapshot(ms: string) {
    return this.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`);
  }
}

/** An applicability entry by its catalogue item or requirement code. */
export interface EntryFixture {
  id: string;
  msId: string;
  status: string | null;
  owner: string | null;
  completedBy: string | null;
  holdsGate: boolean;
  gateReason: string | null;
  isApplicable: boolean | null;
  updatedAt: Date;
}

export async function entryOf(db: TestDatabase, org: DemoOrg, ms: string, code: string): Promise<EntryFixture> {
  return inOrg(db, org, async (trx) => {
    const { rows } = await sql<{
      id: string; management_system_id: string; implementation_status: string | null; owner: string | null; completed_by: string | null;
      holds_gate: boolean; gate_reason: string | null; is_applicable: boolean | null; updated_at: Date;
    }>`
      select e.id, e.management_system_id, e.implementation_status, o.handle as owner, c.handle as completed_by, e.holds_gate,
             e.gate_reason, e.is_applicable, e.updated_at
        from applicability_entry e
        join management_system m on m.id = e.management_system_id and m.slug = ${ms}
        left join ref.catalogue_item ci on ci.id = e.catalogue_item_id
        left join ref.requirement rq on rq.id = e.requirement_id
        left join platform.app_user o on o.id = e.owner_user_id
        left join platform.app_user c on c.id = e.completed_by_user_id
       where e.deleted_at is null and coalesce(ci.item_code, rq.requirement_code) = ${code}`.execute(trx);
    const r = rows[0];
    if (!r) throw new Error(`No entry ${code} in ${org}/${ms}`);
    return {
      id: r.id, msId: r.management_system_id, status: r.implementation_status, owner: r.owner, completedBy: r.completed_by,
      holdsGate: r.holds_gate, gateReason: r.gate_reason, isApplicable: r.is_applicable, updatedAt: r.updated_at,
    };
  });
}

/** Entries of a system with a status, in position order (catalogue item or requirement codes). */
export async function entriesWithStatus(db: TestDatabase, org: DemoOrg, ms: string, status: string): Promise<{ code: string; id: string; owner: string | null }[]> {
  return inOrg(db, org, async (trx) => {
    const { rows } = await sql<{ code: string; id: string; owner: string | null }>`
      select coalesce(ci.item_code, rq.requirement_code) as code, e.id, o.handle as owner
        from applicability_entry e
        join management_system m on m.id = e.management_system_id and m.slug = ${ms}
        left join ref.catalogue_item ci on ci.id = e.catalogue_item_id
        left join ref.requirement rq on rq.id = e.requirement_id
        left join platform.app_user o on o.id = e.owner_user_id
       where e.deleted_at is null and e.implementation_status = ${status}
       order by e.position`.execute(trx);
    return rows;
  });
}

export interface ActivityFixture {
  id: string;
  msId: string;
  status: string;
  owner: string | null;
  completedBy: string | null;
  outputDocumentCode: string | null;
  outputDocumentId: string | null;
  blockerRef: string | null;
}

/** An activity by `<phase>.<activity>`. */
export async function activityOf(db: TestDatabase, org: DemoOrg, ms: string, no: string): Promise<ActivityFixture> {
  const [phase, activity] = no.split('.').map(Number);
  return inOrg(db, org, async (trx) => {
    const { rows } = await sql<{
      id: string; management_system_id: string; status: string; owner: string | null; completed_by: string | null;
      output_document_code: string | null; output_document_id: string | null; blocker_gate_item_ref: string | null;
    }>`
      select a.id, a.management_system_id, a.status, o.handle as owner, c.handle as completed_by, a.output_document_code,
             a.output_document_id, a.blocker_gate_item_ref
        from implementation_activity_progress a
        join management_system m on m.id = a.management_system_id and m.slug = ${ms}
        left join platform.app_user o on o.id = a.owner_user_id
        left join platform.app_user c on c.id = a.completed_by_user_id
       where a.deleted_at is null and a.phase_no = ${phase} and a.activity_no = ${activity}`.execute(trx);
    const r = rows[0];
    if (!r) throw new Error(`No activity ${no} in ${org}/${ms}`);
    return {
      id: r.id, msId: r.management_system_id, status: r.status, owner: r.owner, completedBy: r.completed_by,
      outputDocumentCode: r.output_document_code, outputDocumentId: r.output_document_id, blockerRef: r.blocker_gate_item_ref,
    };
  });
}

/** Activities of a system with a status, in phase and activity order. */
export async function activitiesWithStatus(db: TestDatabase, org: DemoOrg, ms: string, status: string): Promise<{ no: string; id: string; owner: string | null; out: string | null; docId: string | null }[]> {
  return inOrg(db, org, async (trx) => {
    const { rows } = await sql<{ no: string; id: string; owner: string | null; out: string | null; doc_id: string | null }>`
      select a.phase_no || '.' || a.activity_no as no, a.id, o.handle as owner, a.output_document_code as out, a.output_document_id as doc_id
        from implementation_activity_progress a
        join management_system m on m.id = a.management_system_id and m.slug = ${ms}
        left join platform.app_user o on o.id = a.owner_user_id
       where a.deleted_at is null and a.status = ${status}
       order by a.phase_no, a.activity_no`.execute(trx);
    return rows.map((r) => ({ no: r.no, id: r.id, owner: r.owner, out: r.out, docId: r.doc_id }));
  });
}

/** Grants a business role in a system (fixture for a second verifier). */
export async function grantRole(db: TestDatabase, org: DemoOrg, ms: string, handle: string, role: string): Promise<void> {
  const user = await userId(db, handle);
  await inOrg(db, org, async (trx) => {
    await sql`insert into user_ms_role (user_id, management_system_id, role)
              select ${user}::uuid, id, ${role} from management_system where slug = ${ms}`.execute(trx);
  });
}

/** Audit entries of a record, oldest first. */
export async function auditOf(db: TestDatabase, org: DemoOrg, entityId: string): Promise<{ action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; actor: string | null }[]> {
  return inOrg(db, org, async (trx) => {
    const { rows } = await sql<{ action: string; before_data: Record<string, unknown> | null; after_data: Record<string, unknown> | null; actor: string | null }>`
      select t.action, t.before_data, t.after_data, u.handle as actor from audit_trail t
        left join platform.app_user u on u.id = t.actor_user_id
       where t.entity_id = ${entityId} order by t.seq`.execute(trx);
    return rows.map((r) => ({ action: r.action, before: r.before_data, after: r.after_data, actor: r.actor }));
  });
}

/** F.11 verification of an organisation's tenant chain: rows checked and the first broken sequence number. */
export async function verifyChain(db: TestDatabase, org: DemoOrg): Promise<{ checked: number; firstBroken: string | null }> {
  return inOrg(db, org, async (trx) => {
    const { rows } = await chainVerificationQuery('audit_trail').execute(trx);
    return { checked: Number(rows[0]!.checked), firstBroken: rows[0]!.first_broken_seq };
  });
}

export const ENTRY_URL = (ms: string, id: string) => `/api/v1/ms/${ms}/applicability/${id}`;
export const ACTIVITY_URL = (ms: string, id: string) => `/api/v1/ms/${ms}/activities/${id}/transitions`;
