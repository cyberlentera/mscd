// The demo template plus every WP-22 job (and the WP-12 handlers the worker schedules) run once keeps the parity of
// the read model (build plan G.9, J.4, J.8): `GET /ui/ms/{ms}` for ndt, bsd and rmn as `rina` still equals the sample,
// `GET /ui/org` is unchanged, and the My Tasks counts of the four personas stay at 3, 31, 1 and 3 although the jobs
// stored BR-10 tasks (D-29: stored tasks merge into existing chain items).
import { Global, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TaskList, UiMsSnapshot } from '@mscd/shared';
import { Logger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import { GATEWAY_CLIENT } from '../../../src/common/tokens';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuditChainVerifier } from '../../../src/modules/audit/chain-verifier';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { FreshnessModule } from '../../../src/modules/freshness/freshness.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { JobsModule } from '../../../src/modules/jobs/jobs.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { PacksModule } from '../../../src/modules/packs/packs.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { UiModule } from '../../../src/modules/ui/ui.module';
import { loadSampleSnapshot } from '../../../src/seed/snapshot';
import { WorkerRuntime } from '../../../src/worker/worker-runtime';
import { WorkerRuntimeModule } from '../../../src/worker/worker-runtime.module';
import { differences, normaliseMs, sampleMsSnapshot } from '../parity/compare';
import { ORG_IDS, sessionFor, type DemoOrg, type ReadModelApp, type UiClient } from '../read-model/helpers';
import { useTestDatabase } from '../../setup/test-db';
import { adminClient, JOB_TEST_ENV, RecordingGateway, type AdminClient } from './helpers';

const sample = loadSampleSnapshot();
const ORGS: readonly Exclude<DemoOrg, 'tst'>[] = ['ndt', 'bsd', 'rmn'];
const MY_TASKS: Record<string, number> = { rina: 3, bagus: 31, maya: 1, hendra: 3 };

@Global()
@Module({ providers: [{ provide: GATEWAY_CLIENT, useValue: new RecordingGateway() }], exports: [GATEWAY_CLIENT] })
class TestGatewayModule {}

describe('demo template after every job (G.9)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  let queue: InMemoryJobQueue;
  let admin: AdminClient;
  const before = new Map<string, unknown>();
  const clients = new Map<string, UiClient>();

  const get = async <T,>(org: DemoOrg, handle: string, url: string): Promise<T> => {
    const key = `${org}:${handle}`;
    if (!clients.has(key)) clients.set(key, await sessionFor(ctx, db, handle, org));
    const response = await clients.get(key)!.get<T>(url);
    expect(response.status).toBe(200);
    return response.body;
  };
  /**
   * The snapshot without its clock and without the weak ETags of the refs: a job that stores derived values (stored
   * freshness and integrity, E.3) updates the row, so its ETag changes while every field the UI shows stays equal.
   */
  const withoutClock = (value: unknown) => {
    const copy = structuredClone(value) as Record<string, unknown>;
    delete copy.generatedAt;
    const refs = copy.refs as Record<string, { etag?: string }> | undefined;
    if (refs) for (const ref of Object.values(refs)) delete ref.etag;
    return copy;
  };

  beforeAll(async () => {
    const env = { MSCD__MAIL__SMTP__PORT: '9', ...JOB_TEST_ENV };
    const config = db.config(env);
    const moduleRef = await db
      .createTestingModule(
        {
          imports: [
            TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, UiModule,
            PacksModule, JobsModule, FreshnessModule, WorkerRuntimeModule, TestGatewayModule,
          ],
        },
        env,
      )
      .compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
    app.useLogger(app.get(Logger));
    await configureHttpApplication(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    ctx = { app, moduleRef, close: () => app.close() };
    queue = moduleRef.get<InMemoryJobQueue>(JOB_QUEUE);
    admin = await adminClient(db);

    // The API before any job ran.
    for (const org of ORGS) {
      before.set(`${org}:org`, withoutClock(await get(org, 'rina', '/api/v1/ui/org')));
      for (const ms of sample.snapshots[org]!.orgs.find((o) => o.id === org)!.ms) {
        before.set(`${org}:${ms}`, withoutClock(await get(org, 'rina', `/api/v1/ui/ms/${ms}`)));
      }
    }
    for (const handle of Object.keys(MY_TASKS)) before.set(`tasks:${handle}`, await get('ndt', handle, '/api/v1/tasks'));

    // Every job once: installation jobs, then the daily jobs of every organisation, then a recompute of everything.
    await moduleRef.get(WorkerRuntime).start();
    const send = async (name: Parameters<InMemoryJobQueue['send']>[0], orgId: string | null) => {
      await queue.send(name, { orgId, payload: {} } as never, { singletonKey: `parity:${name}:${orgId ?? 'all'}` });
    };
    for (const name of ['scheduler.tick', 'cleanup.expired', 'packs.lifecycle', 'audit.verify-chain'] as const) await send(name, null);
    for (const orgId of Object.values(ORG_IDS)) {
      for (const name of ['license.check', 'tasks.overdue', 'audit-prep.generate', 'freshness.sweep', 'freshness.recompute'] as const) await send(name, orgId);
    }
    await queue.drain({ includeDelayed: true });
  }, 180_000);
  afterAll(async () => {
    await ctx?.close();
    await admin?.end();
  });

  it('ran every job without a failure and stored their results', async () => {
    expect(queue.failed()).toEqual([]);
    const ran = new Set(queue.completed().map((j) => j.name));
    for (const name of [
      'scheduler.tick', 'cleanup.expired', 'packs.lifecycle', 'edition.withdrawn-alerts', 'audit.verify-chain', 'license.check',
      'tasks.overdue', 'audit-prep.generate', 'freshness.sweep', 'freshness.recompute',
    ]) {
      expect(ran.has(name as never), name).toBe(true);
    }
    const tasks = await admin.query<{ source_rule: string; n: number }>(
      `SELECT source_rule, count(*)::int AS n FROM org_ndt.task WHERE status = 'open' GROUP BY 1 ORDER BY 1`,
    );
    // The six expired documents of ndt now have BR-10 tasks; no evidence was downgraded on the demo data.
    expect(tasks.rows).toEqual([{ source_rule: 'BR-10', n: 6 }]);
    const anchors = await admin.query<{ chain: string }>(`SELECT chain FROM platform.audit_anchor`);
    expect(anchors.rows.map((r) => r.chain)).toContain('platform.audit_log');
    const verifier = ctx.moduleRef.get(AuditChainVerifier);
    for (const [slug, orgId] of Object.entries(ORG_IDS)) {
      expect(await verifier.verifyTenant({ orgId, schema: `org_${slug}` })).toMatchObject({ firstBrokenSeq: null, anchorOk: true });
    }
    expect(await verifier.verifyPlatform()).toMatchObject({ firstBrokenSeq: null, anchorOk: true });
    const unset = await admin.query(`SELECT 1 FROM org_ndt.evidence WHERE deleted_at IS NULL AND freshness_status IS NULL`);
    expect(unset.rows).toEqual([]);
  });

  for (const org of ORGS) {
    it(`${org}: every system snapshot still equals the sample and the organisation snapshot is unchanged`, async () => {
      for (const ms of sample.snapshots[org]!.orgs.find((o) => o.id === org)!.ms) {
        const after = await get<UiMsSnapshot>(org, 'rina', `/api/v1/ui/ms/${ms}`);
        const { api, sample: expected, wireMismatches } = normaliseMs(after, sampleMsSnapshot(sample.snapshots[org]!, ms));
        expect(wireMismatches).toEqual([]);
        expect({ ms, diff: differences(api, expected) }).toEqual({ ms, diff: [] });
        expect({ ms, diff: differences(withoutClock(after), before.get(`${org}:${ms}`)) }).toEqual({ ms, diff: [] });
      }
      const orgAfter = withoutClock(await get(org, 'rina', '/api/v1/ui/org'));
      expect(differences(orgAfter, before.get(`${org}:org`))).toEqual([]);
    });
  }

  it('keeps the My Tasks counts of the four personas: the stored tasks merge into their chain items (D-29)', async () => {
    for (const [handle, total] of Object.entries(MY_TASKS)) {
      const after = await get<TaskList>('ndt', handle, '/api/v1/tasks');
      expect({ handle, total: after.counts.total }).toEqual({ handle, total });
      expect(after.items.every((i) => i.kind !== 'task')).toBe(true);
      expect(differences(after, before.get(`tasks:${handle}`))).toEqual([]);
    }
  });
});
