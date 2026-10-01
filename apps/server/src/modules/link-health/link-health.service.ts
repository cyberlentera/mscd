// Link health planning and checks (build plan E.2 `link-health.plan`, `link-health.check`, E.4, TS 5.5, TS 5.7) and
// the on-demand run of one system (`POST /ms/{ms}/link-health/run`, D.3).
//
// Selection (TS 5.5): priority 1 is storage objects behind evidence of `implemented` entries, due after 24 hours;
// priority 2 is evidence of systems with a queued or building evidence pack, 24 hours; priority 3 is every other
// evidence and document version object, 7 days. Read-only repositories are checked too (TS 5.7). Each check job takes
// one repository's batch of at most 50 objects, asks the gateway `stat` under the repository's token bucket and
// stores the E.4 status. A throttled provider leaves every status as it is: the rest of the batch is queued again
// after `Retry-After`.
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CommandResult, GatewayObjectRef, GatewayRepository, GatewayTenant, StatResult, StorageAdapter } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { JOB_QUEUE, type JobQueue, type JobRun } from '../../common/jobs/job-queue';
import { BusinessRuleError, NotFoundError } from '../../common/problems';
import {
  GATEWAY_CLIENT,
  LICENCE_GATE,
  SYSTEM_USER_ID,
  type GatewayClient,
  type LicenceGate,
  type Principal,
  type TenantInfo,
  type Trx,
} from '../../common/tokens';
import { FRESHNESS_RECOMPUTE_DELAY_SECONDS, freshnessRecomputeKey } from '../freshness/freshness.jobs';
import { windowNow } from '../jobs/job-support';
import { TenantJobRunner } from '../jobs/tenant-job';
import { GatewayProblemError, StorageGatewayContext } from '../storage';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { decideLinkStatus } from './link-status';
import { LinkStatusWriter, type LinkObjectRow } from './link-status-writer';
import { RequestPacer } from './request-pacer';

/** E.2: `link-health.check` batches of at most 50 objects of one repository. */
export const LINK_CHECK_BATCH = 50;
/** E.2: `link-health.check` retries 5 times with backoff. */
export const LINK_CHECK_RETRY_LIMIT = 5;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface DueBatch {
  repositoryId: string;
  storageObjectIds: string[];
}

export interface CheckSummary {
  checked: number;
  changed: number;
  rescheduled: number;
  errors: number;
}

/**
 * E.2 singleton key `lhc:<org>:<repo>:<sha1 of ids>`; a rescheduled rest adds the instant it may run. A batch of an
 * on-demand run adds its task id, so a second run of the same system is never dropped as a duplicate of the first
 * (its task would then wait forever).
 */
export function linkCheckKey(orgId: string, repositoryId: string, ids: readonly string[], notBefore?: Date, taskId?: string): string {
  const hash = createHash('sha1')
    .update([...ids].join(','))
    .update(notBefore ? `@${notBefore.toISOString()}` : '')
    .update(taskId ? `#${taskId}` : '')
    .digest('hex');
  return `lhc:${orgId}:${repositoryId}:${hash}`;
}

/** Splits ids per repository into batches of `LINK_CHECK_BATCH`, keeping their order. */
export function batchesOf(rows: readonly { id: string; storage_repository_id: string }[]): DueBatch[] {
  const byRepository = new Map<string, string[]>();
  for (const row of rows) {
    let list = byRepository.get(row.storage_repository_id);
    if (!list) byRepository.set(row.storage_repository_id, (list = []));
    list.push(row.id);
  }
  const batches: DueBatch[] = [];
  for (const [repositoryId, ids] of byRepository) {
    for (let i = 0; i < ids.length; i += LINK_CHECK_BATCH) batches.push({ repositoryId, storageObjectIds: ids.slice(i, i + LINK_CHECK_BATCH) });
  }
  return batches;
}

/**
 * Maps a gateway problem of a `stat` call to the outcome it stands for (null: an error that changes nothing). An item
 * moved outside the root is already a `forbidden` outcome of the adapters; a refused `outside-root` problem means the
 * stored id does not belong to the repository at all, which is a data error and leaves the status as it is.
 */
function outcomeOfProblem(error: GatewayProblemError): StatResult | null {
  switch (error.gatewaySlug) {
    case 'not-found':
      return { outcome: 'not_found', pinnedVersionAvailable: false };
    case 'forbidden':
      // A sealed credential that no longer fits the repository (D-08) or none at all: the credential is invalid.
      if (error.reason === 'credential-binding' || error.reason === 'credential-missing' || error.reason === 'credential-kind') {
        return { outcome: 'unreachable', detail: 'credential_invalid', pinnedVersionAvailable: false };
      }
      return { outcome: 'forbidden', pinnedVersionAvailable: false };
    case 'unreachable':
      return { outcome: 'unreachable', pinnedVersionAvailable: false };
    case 'rate-limited':
      return { outcome: 'rate_limited', pinnedVersionAvailable: false, retryAfterSeconds: Number(error.extras.retryAfter ?? 60) };
    default:
      return null;
  }
}

@Injectable()
export class LinkHealthService {
  private readonly logger = new Logger('LinkHealth');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly gatewayContext: StorageGatewayContext,
    private readonly writer: LinkStatusWriter,
    private readonly pacer: RequestPacer,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
  ) {}

  /** Whether the organisation's licence includes `link_health_monitor`. */
  async monitorLicensed(orgId: string, trx?: Trx): Promise<boolean> {
    try {
      await this.licence.assertFeature(orgId, 'link_health_monitor', trx);
      return true;
    } catch (error) {
      if (error instanceof BusinessRuleError) return false;
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------------- selection

  /** Storage objects due for a check at `at` (TS 5.5 priorities and windows), in check order. */
  async dueObjects(trx: Trx, at: Date): Promise<{ id: string; storage_repository_id: string; priority: number }[]> {
    const day = new Date(at.getTime() - DAY_MS);
    const week = new Date(at.getTime() - 7 * DAY_MS);
    const rows = await sql<{ id: string; storage_repository_id: string; priority: number }>`
      with evidence_objects as (
        select e.storage_object_id as id,
               bool_or(ae.implementation_status = 'implemented') as implemented,
               bool_or(t.management_system_id = any(
                 select p.management_system_id from evidence_pack p where p.status in ('queued', 'building') and p.deleted_at is null
               )) as in_pack
        from evidence e
        left join evidence_target t on t.evidence_id = e.id and t.deleted_at is null
        left join applicability_entry ae on ae.id = t.applicability_entry_id and ae.deleted_at is null
        where e.deleted_at is null and e.storage_object_id is not null
        group by e.storage_object_id
      ),
      document_objects as (
        select distinct v.storage_object_id as id
        from document_version v join document d on d.id = v.document_id and d.deleted_at is null
        where v.deleted_at is null
      ),
      candidates as (
        select o.id, o.storage_repository_id, o.last_verified_at,
               case when coalesce(eo.implemented, false) then 1 when coalesce(eo.in_pack, false) then 2 else 3 end as priority
        from storage_object o
        join storage_repository r on r.id = o.storage_repository_id and r.deleted_at is null
        left join evidence_objects eo on eo.id = o.id
        where o.deleted_at is null
          and (eo.id is not null or o.id in (select id from document_objects))
      )
      select id, storage_repository_id, priority from candidates
      where last_verified_at is null or last_verified_at < case when priority = 3 then ${week}::timestamptz else ${day}::timestamptz end
      order by priority, last_verified_at nulls first, id`.execute(trx);
    return rows.rows;
  }

  /** Every file reference of one system: evidence targeting it and document versions of its documents. */
  private async systemObjects(trx: Trx, msId: string): Promise<{ id: string; storage_repository_id: string }[]> {
    const rows = await sql<{ id: string; storage_repository_id: string }>`
      select o.id, o.storage_repository_id from storage_object o
      join storage_repository r on r.id = o.storage_repository_id and r.deleted_at is null
      where o.deleted_at is null and (
        o.id in (select e.storage_object_id from evidence e join evidence_target t on t.evidence_id = e.id and t.deleted_at is null
                 where e.deleted_at is null and t.management_system_id = ${msId}::uuid)
        or o.id in (select v.storage_object_id from document_version v join document d on d.id = v.document_id and d.deleted_at is null
                    where v.deleted_at is null and (d.is_org_wide or d.id in (
                      select l.entity_id from entity_ms_link l where l.entity_type = 'document' and l.deleted_at is null
                        and l.management_system_id = ${msId}::uuid)))
      )
      order by o.storage_repository_id, o.last_verified_at nulls first, o.id`.execute(trx);
    return rows.rows;
  }

  private async sendBatches(trx: Trx, org: TenantInfo, batches: readonly DueBatch[], options: { taskId?: string; requestId?: string; requestedBy?: string }) {
    for (const batch of batches) {
      await this.jobs.send(
        'link-health.check',
        {
          orgId: org.id,
          requestId: options.requestId,
          requestedBy: options.requestedBy,
          payload: { repositoryId: batch.repositoryId, storageObjectIds: batch.storageObjectIds, ...(options.taskId ? { taskId: options.taskId } : {}) },
        },
        { singletonKey: linkCheckKey(org.id, batch.repositoryId, batch.storageObjectIds, undefined, options.taskId), retryLimit: LINK_CHECK_RETRY_LIMIT },
        trx,
      );
    }
  }

  // ------------------------------------------------------------------------------------------------- jobs

  /** `link-health.plan`: queues the due objects in batches, only with the `link_health_monitor` feature. */
  async plan(org: TenantInfo, requestId?: string): Promise<{ licensed: boolean; objects: number; batches: number }> {
    if (!(await this.monitorLicensed(org.id))) return { licensed: false, objects: 0, batches: 0 };
    const at = windowNow(this.clock, org.timeZone);
    return this.runner.run(
      org,
      async (trx) => {
        const due = await this.dueObjects(trx, at);
        const batches = batchesOf(due);
        await this.sendBatches(trx, org, batches, { requestId });
        return { licensed: true, objects: due.length, batches: batches.length };
      },
      requestId,
    );
  }

  /** `link-health.check`: E.4 for one batch of one repository. */
  async check(org: TenantInfo, job: JobRun<'link-health.check'>): Promise<CheckSummary> {
    const { repositoryId, storageObjectIds, taskId } = job.env.payload;
    const summary: CheckSummary = { checked: 0, changed: 0, rescheduled: 0, errors: 0 };
    const prepared = await this.runner.run(
      org,
      async (trx) => {
        const repository = await trx
          .selectFrom('storage_repository')
          .selectAll()
          .where('id', '=', repositoryId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!repository) return null;
        const objects = (await this.writer.objects(trx, storageObjectIds)).filter((o) => o.storage_repository_id === repositoryId);
        const order = new Map(storageObjectIds.map((id, index) => [id, index]));
        objects.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        if (taskId) await this.startTask(trx, taskId, job.id);
        return {
          adapter: repository.adapter as StorageAdapter,
          tenant: await this.gatewayContext.tenant(trx, org.id),
          descriptor: await this.gatewayContext.repository(trx, repository),
          objects,
        };
      },
      job.env.requestId,
    );
    if (!prepared) {
      if (taskId) await this.runner.run(org, (trx) => this.progressTask(trx, taskId, storageObjectIds.length, 0), job.env.requestId);
      return summary;
    }
    const missing = storageObjectIds.length - prepared.objects.length;
    const affected = new Set<string>();
    // The run's `checked` count moves once per job, at its end (or for the part done before a throttled rest is
    // queued again), so a retried batch is never counted twice. A status change counts as it commits: on a retry the
    // same object no longer changes, so `changed` cannot double either.
    let counted = missing;
    try {
      for (let index = 0; index < prepared.objects.length; index += 1) {
        const object = prepared.objects[index]!;
        await this.pacer.take(repositoryId, prepared.adapter);
        const result = await this.stat(prepared.tenant, prepared.descriptor, object, job.env.requestId);
        if (result === null) {
          summary.errors += 1;
          summary.checked += 1;
          counted += 1;
          continue;
        }
        if (result.outcome === 'rate_limited') {
          const rest = prepared.objects.slice(index).map((o) => o.id);
          summary.rescheduled = rest.length;
          await this.reschedule(org, job, rest, result.retryAfterSeconds ?? 60, object);
          break;
        }
        const at = windowNow(this.clock, org.timeZone);
        const decision = decideLinkStatus(
          {
            linkStatus: object.link_status,
            linkStatusReason: object.link_status_reason,
            linkStatusSince: object.link_status_since,
            hashAlgorithm: object.hash_algorithm,
            hashSource: object.hash_source,
            externalVersionId: object.external_version_id,
            hashValue: object.hash_value,
            folderPath: object.folder_path,
          },
          result,
          at,
          prepared.adapter,
        );
        const applied = await this.runner.run(
          org,
          async (trx) => {
            const outcome = await this.writer.apply(trx, object, {
              outcome: result.outcome,
              status: decision.status,
              reason: decision.reason,
              verified: true,
              found: decision.found,
              folderPath: decision.folderPath,
              observedVersionId: result.current?.externalVersionId ?? null,
              observedHash: result.current?.hashValue ?? null,
              observedFolderPath: result.folderPath ?? result.current?.folderPath ?? null,
              detail: result.detail ? { detail: result.detail } : null,
              at,
              jobId: job.id,
              source: 'link-health.check',
            });
            if (taskId && outcome.changed) await this.progressTask(trx, taskId, 0, 1);
            return outcome;
          },
          job.env.requestId,
        );
        summary.checked += 1;
        counted += 1;
        if (applied.changed) summary.changed += 1;
        if (applied.affectsValidity) for (const ms of applied.msIds) affected.add(ms);
      }
    } catch (error) {
      if (taskId && job.attempt > LINK_CHECK_RETRY_LIMIT) await this.runner.run(org, (trx) => this.failTask(trx, taskId, error), job.env.requestId);
      throw error;
    } finally {
      if (affected.size > 0) await this.runner.run(org, (trx) => this.queueFreshness(trx, org, [...affected], job.env.requestId), job.env.requestId);
    }
    if (taskId && counted > 0) await this.runner.run(org, (trx) => this.progressTask(trx, taskId, counted, 0), job.env.requestId);
    return summary;
  }

  /** Gateway `stat`; problems answered by the gateway stand for an outcome, null for other refusals. */
  private async stat(tenant: GatewayTenant, repository: GatewayRepository, object: LinkObjectRow, requestId?: string): Promise<StatResult | null> {
    const ref: GatewayObjectRef = {
      externalItemId: object.external_item_id,
      externalVersionId: object.external_version_id,
      hashAlgorithm: object.hash_algorithm,
      hashValue: object.hash_value,
      hashSource: object.hash_source,
      folderPath: object.folder_path,
    };
    try {
      return await this.gateway.post<StatResult>('/v1/stat', { tenant, repository, object: ref }, { requestId });
    } catch (error) {
      if (!(error instanceof GatewayProblemError)) throw error;
      const mapped = outcomeOfProblem(error);
      if (!mapped) this.logger.warn({ objectId: object.id, slug: error.gatewaySlug, detail: error.gatewayDetail }, 'stat refused; status kept');
      return mapped;
    }
  }

  /** Queues the rest of a throttled batch after `Retry-After`; statuses stay as they are (TS 5.7). */
  private async reschedule(org: TenantInfo, job: JobRun<'link-health.check'>, rest: string[], retryAfterSeconds: number, throttled: LinkObjectRow): Promise<void> {
    const delay = Math.max(1, Math.ceil(retryAfterSeconds));
    const notBefore = new Date(this.clock.now().getTime() + delay * 1000);
    const { repositoryId, taskId } = job.env.payload;
    await this.runner.run(
      org,
      async (trx) => {
        await trx
          .insertInto('link_health_result')
          .values({
            storage_object_id: throttled.id,
            checked_at: windowNow(this.clock, org.timeZone),
            outcome: 'rate_limited',
            status_before: throttled.link_status,
            status_after: throttled.link_status,
            detail: JSON.stringify({ retryAfterSeconds: delay, rescheduled: rest.length }),
            job_id: job.id,
          })
          .execute();
        await this.jobs.send(
          'link-health.check',
          { orgId: org.id, requestId: job.env.requestId, requestedBy: job.env.requestedBy, payload: { repositoryId, storageObjectIds: rest, ...(taskId ? { taskId } : {}) } },
          { singletonKey: linkCheckKey(org.id, repositoryId, rest, notBefore, taskId), startAfterSeconds: delay, retryLimit: LINK_CHECK_RETRY_LIMIT },
          trx,
        );
      },
      job.env.requestId,
    );
    this.logger.log({ jobId: job.id, orgId: org.id, repositoryId, rescheduled: rest.length, retryAfterSeconds: delay }, 'link-health.check throttled, rest rescheduled');
  }

  private async queueFreshness(trx: Trx, org: TenantInfo, msIds: readonly string[], requestId?: string): Promise<void> {
    for (const msId of msIds) {
      await this.jobs.send(
        'freshness.recompute',
        { orgId: org.id, requestId, payload: { msId } },
        { singletonKey: freshnessRecomputeKey(org.id, msId), startAfterSeconds: FRESHNESS_RECOMPUTE_DELAY_SECONDS, retryLimit: 3 },
        trx,
      );
    }
  }

  // ------------------------------------------------------------------------------------------------- background task

  private async startTask(trx: Trx, taskId: string, jobId: string): Promise<void> {
    await trx
      .updateTable('background_task')
      .set({ status: 'running', started_at: sql<Date>`coalesce(started_at, now())`, job_id: sql<string>`coalesce(job_id, ${jobId})`, updated_at: sql<Date>`now()` })
      .where('id', '=', taskId)
      .where('status', '=', 'queued')
      .execute();
  }

  /** Adds `checked` objects (and `changed` status changes) to the run; the run succeeds when every object is done. */
  private async progressTask(trx: Trx, taskId: string, checked: number, changed: number): Promise<void> {
    await sql`
      update background_task set
        result = jsonb_build_object(
          'checked', coalesce((result->>'checked')::int, 0) + ${checked}::int,
          'changed', coalesce((result->>'changed')::int, 0) + ${changed}::int),
        progress = least(100, floor(100.0 * (coalesce((result->>'checked')::int, 0) + ${checked}::int)
                                 / greatest(coalesce((params->>'total')::int, 1), 1)))::smallint,
        status = case when coalesce((result->>'checked')::int, 0) + ${checked}::int >= coalesce((params->>'total')::int, 0)
                      then 'succeeded' else 'running' end,
        started_at = coalesce(started_at, now()),
        finished_at = case when coalesce((result->>'checked')::int, 0) + ${checked}::int >= coalesce((params->>'total')::int, 0)
                           then now() else null end,
        updated_at = now()
      where id = ${taskId}::uuid and status in ('queued', 'running')`.execute(trx);
  }

  private async failTask(trx: Trx, taskId: string, error: unknown): Promise<void> {
    await trx
      .updateTable('background_task')
      .set({ status: 'failed', error: error instanceof Error ? error.message.slice(0, 2000) : String(error), finished_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
      .where('id', '=', taskId)
      .where('status', 'in', ['queued', 'running'])
      .execute();
  }

  // ------------------------------------------------------------------------------------------------- route

  /** `POST /ms/{ms}/link-health/run`: every file reference of the system now, as one `link_health_run` task. */
  async run(principal: Principal, msSlug: string, requestId?: string): Promise<CommandResult> {
    const org = principal.org!;
    return this.scope.withTenant(tenantContextOf(principal, requestId), async (trx) => {
      const system = await trx
        .selectFrom('management_system')
        .select(['id', 'slug'])
        .where('slug', '=', msSlug)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!system) throw new NotFoundError('No such management system');
      await this.licence.assertFeature(org.id, 'link_health_monitor', trx);
      const objects = await this.systemObjects(trx, system.id);
      const task = await trx
        .insertInto('background_task')
        .values({
          kind: 'link_health_run',
          management_system_id: system.id,
          status: objects.length === 0 ? 'succeeded' : 'queued',
          progress: objects.length === 0 ? 100 : 0,
          params: JSON.stringify({ ms: system.slug, total: objects.length }),
          result: JSON.stringify({ checked: 0, changed: 0 }),
          ...(objects.length === 0 ? { finished_at: sql<Date>`now()` } : {}),
          created_by: principal.user.id,
          updated_by: principal.user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.sendBatches(trx, org, batchesOf(objects), { taskId: task.id, requestId, requestedBy: principal.user.id ?? SYSTEM_USER_ID });
      const n = objects.length;
      return {
        ok: true,
        changed: [],
        count: n,
        taskId: task.id,
        message: [
          n === 1 ? 'Checking 1 file reference' : `Checking ${n} file references`,
          `Memeriksa ${n} rujukan berkas`,
        ],
      };
    });
  }
}
