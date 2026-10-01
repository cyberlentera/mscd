// Operations of the platform operator (D.3 "Operations", WP-34): installation health, queue statistics and the
// manual run of an allow-listed job.
import { Inject, Injectable } from '@nestjs/common';
import { OPS_RUNNABLE_JOBS, type JobRunRequest, type OpsHealth, type OpsRunnableJob, type QueueStats } from '@mscd/shared';
import { sql } from 'kysely';
import { JobHandlerRegistry } from '../../common/jobs/job-handler';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { ConflictError, NotFoundError, ProblemError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import { AUDIT_WRITER, type AuditWriter, type Principal, type TenantInfo, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { MIGRATIONS_BY_FOLDER } from '../../generated/build-info';
import { DAILY_JOBS, cronRetryLimit } from '../jobs/schedules';
import { ReadinessService } from '../platform/readiness.service';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope } from '../tenancy/tenant-scope';
import { OpsMetricsCollector, type ActiveOrganisation } from './ops-metrics.collector';

type Component = OpsHealth['components'][number];
type MigrationState = OpsHealth['migrations'][number];

const ALLOWED: ReadonlySet<string> = new Set(OPS_RUNNABLE_JOBS);

/** E.2 retry limit of a job run by hand: its daily or cron entry, else 3. */
export function retryLimitOf(name: OpsRunnableJob): number {
  return DAILY_JOBS.find((d) => d.name === name)?.retryLimit ?? cronRetryLimit(name);
}

/** Singleton key of a manual run: one waiting run per job and organisation (or installation). */
export function manualRunKey(name: OpsRunnableJob, orgId: string | null): string {
  return `ops:${name}:${orgId ?? 'all'}`;
}

function rule(detail: string, id: string): ProblemError {
  return new ProblemError('business-rule', { detail, messageKey: `ops.${id}`, messages: { en: detail, id: detail } });
}

@Injectable()
export class OpsService {
  constructor(
    private readonly config: MscdConfig,
    private readonly readiness: ReadinessService,
    private readonly collector: OpsMetricsCollector,
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly handlers: JobHandlerRegistry,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** `GET /ops/health`: readiness checks, queue driver, outbox, telemetry; migrations; queues; licence states. */
  async health(): Promise<OpsHealth> {
    const components: Component[] = [];
    const report = await this.readiness.evaluate();
    for (const check of report.checks) {
      components.push({ name: check.name, status: check.status === 'ok' ? 'ok' : 'down', detail: check.detail ?? `${check.durationMs} ms` });
    }

    let queues: QueueStats[] = [];
    try {
      queues = await this.collector.queueStats();
      components.push({ name: 'job-queue', status: 'ok', detail: `${this.config.profile.jobs.driver}: ${queues.length} queue(s) with jobs or workers` });
    } catch (error) {
      components.push({ name: 'job-queue', status: 'down', detail: (error as Error).message });
    }

    try {
      const outbox = await this.collector.outboxHealth();
      components.push(
        outbox.stuckRows > 0
          ? { name: 'job-outbox', status: 'degraded', detail: `${outbox.stuckRows} row(s) no longer relayed, oldest from ${outbox.oldestStuckAt?.toISOString() ?? 'unknown'}` }
          : { name: 'job-outbox', status: 'ok', detail: 'no stuck rows' },
      );
    } catch (error) {
      components.push({ name: 'job-outbox', status: 'down', detail: (error as Error).message });
    }

    const telemetry = this.config.profile.telemetry;
    components.push({
      name: 'telemetry',
      status: 'ok',
      detail: telemetry.enabled && telemetry.otlp_endpoint ? `traces to ${new URL(telemetry.otlp_endpoint).origin}` : 'off',
    });

    let orgs: ActiveOrganisation[] = [];
    let licences: OpsHealth['licences'] = [];
    try {
      orgs = await this.collector.activeOrganisations();
      licences = (await this.collector.licenceStates(orgs))
        .filter((l): l is typeof l & { validUntil: string } => l.validUntil !== null)
        .map((l) => ({ org: l.org, state: l.state, validUntil: l.validUntil }));
    } catch (error) {
      components.push({ name: 'licences', status: 'down', detail: (error as Error).message });
    }

    return { components, migrations: await this.migrations(), queues, licences };
  }

  /** `GET /ops/queues`. */
  queues(): Promise<QueueStats[]> {
    return this.collector.queueStats();
  }

  /**
   * `POST /ops/jobs/{name}/run`: queues one run of an allow-listed job with an empty payload. Tenant jobs need
   * `org` (an active organisation); installation-wide jobs refuse it. The job and the `ops.job_run` audit entry
   * commit together.
   */
  async runJob(principal: Principal, name: OpsRunnableJob, body: JobRunRequest): Promise<{ jobId: string }> {
    // The route schema already restricts the name; this keeps the service safe for other callers.
    if (!ALLOWED.has(name)) throw new NotFoundError(`Job ${String(name)} cannot be run by the operator`);
    const handler = this.handlers.discover().find((h) => h.metadata.name === name);
    if (!handler) throw rule(`The job ${name} has no handler in this build`, 'job_unavailable');

    let org: TenantInfo | null = null;
    if (body.org !== undefined) {
      org = await this.tenants.resolveBySlug(body.org);
      if (!org) throw new NotFoundError(`No organisation ${body.org}`);
    }
    if (handler.metadata.scope === 'tenant') {
      if (!org) throw rule(`The job ${name} runs for one organisation: name it in org`, 'org_required');
      if (org.status !== 'active') throw rule(`The organisation ${org.slug} is ${org.status}; jobs run for active organisations only`, 'org_inactive');
    } else if (org) {
      throw rule(`The job ${name} runs for the whole installation and takes no organisation`, 'org_not_allowed');
    }

    const requestId = currentRequestId();
    return this.scope.withPlatform(
      async (trx: Trx) => {
        const jobId = await this.queue.send(
          name,
          { orgId: org?.id ?? null, ...(requestId ? { requestId } : {}), requestedBy: principal.user.id, payload: {} },
          { singletonKey: manualRunKey(name, org?.id ?? null), retryLimit: retryLimitOf(name) },
          trx,
        );
        if (jobId === null) throw new ConflictError(`A run of ${name} requested by an operator is already waiting`);
        await this.audit.record(trx, {
          action: 'ops.job_run',
          actor: { userId: principal.user.id, kind: 'operator' },
          organizationId: org?.id ?? null,
          entityType: 'job',
          entityCode: name,
          after: { job: name, jobId, org: org?.slug ?? null },
        });
        return { jobId };
      },
      { scope: 'operator', orgId: org?.id ?? null, userId: principal.user.id },
    );
  }

  /**
   * Newest applied migration per schema the application role can read, against the newest one of this build:
   * `platform` and `ref`. Tenant schemas keep their migration table private to the migrator and are not listed.
   */
  async migrations(): Promise<MigrationState[]> {
    const schemas: { schema: 'platform' | 'ref'; expected: string | null }[] = [
      { schema: 'platform', expected: MIGRATIONS_BY_FOLDER.platform.at(-1) ?? null },
      { schema: 'ref', expected: MIGRATIONS_BY_FOLDER.ref.at(-1) ?? null },
    ];
    return this.scope.withPlatform(
      async (trx) => {
        const out: MigrationState[] = [];
        for (const { schema, expected } of schemas) {
          const table = `${schema}.kysely_migration`;
          const access = await sql<{ readable: boolean }>`
            select case when to_regclass(${table}) is null then false else has_table_privilege(${table}, 'SELECT') end as readable`.execute(trx);
          if (!access.rows[0]?.readable) continue;
          const { rows } = await sql<{ name: string | null }>`select max(name) as name from ${sql.table(table)}`.execute(trx);
          out.push({ schema, latest: rows[0]?.name ?? null, expected });
        }
        return out;
      },
      { scope: 'operator' },
    );
  }
}
