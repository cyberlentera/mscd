// `integrity.rehash` (build plan E.2, A-08): Managed Vault objects whose content was not re-hashed for 7 days, at
// most 200 per run, oldest first. The gateway decrypts and hashes the stored bytes (`POST /v1/rehash`); a hash that
// no longer matches sets `hash_mismatch` (with `link_status.changed`, a `link_health_result` row and a
// `freshness.recompute` of the systems of the evidence). Every re-hash is recorded as a `link_health_result` row
// with `detail.check = 'rehash'`, which is also how the next run finds the objects that are due.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { GatewayObjectRef, RehashResult } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { GATEWAY_CLIENT, type GatewayClient, type TenantInfo } from '../../common/tokens';
import { FRESHNESS_RECOMPUTE_DELAY_SECONDS, freshnessRecomputeKey } from '../freshness/freshness.jobs';
import { windowNow } from '../jobs/job-support';
import { TenantJobRunner } from '../jobs/tenant-job';
import { LINK_OBJECT_COLUMNS, LinkStatusWriter, type LinkObjectRow, type Observation } from '../link-health/link-status-writer';
import { RequestPacer } from '../link-health/request-pacer';
import { GatewayProblemError, StorageGatewayContext } from '../storage';

/** E.2: at most 200 objects per run. */
export const REHASH_BATCH = 200;
/** E.2: an object is re-hashed again after 7 days. */
export const REHASH_INTERVAL_DAYS = 7;

/** Statuses whose content is worth hashing again (a missing or already broken object is left to the link check). */
const REHASH_STATUSES = ['intact', 'moved', 'version_changed', 'verification_pending'] as const;

export interface RehashSummary {
  due: number;
  matched: number;
  mismatched: number;
  skipped: number;
}

@Injectable()
export class IntegrityService {
  private readonly logger = new Logger('IntegrityRehash');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    private readonly gatewayContext: StorageGatewayContext,
    private readonly writer: LinkStatusWriter,
    private readonly pacer: RequestPacer,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
  ) {}

  async rehash(org: TenantInfo, jobId: string | null, requestId?: string): Promise<RehashSummary> {
    const started = windowNow(this.clock, org.timeZone);
    const since = new Date(started.getTime() - REHASH_INTERVAL_DAYS * 24 * 3_600_000);
    const due = await this.runner.run(
      org,
      async (trx) => {
        const rows = await trx
          .selectFrom('storage_object as o')
          .innerJoin('storage_repository as r', 'r.id', 'o.storage_repository_id')
          .select(LINK_OBJECT_COLUMNS.map((c) => `o.${c}` as const))
          .select(
            sql<Date | null>`(select max(h.checked_at) from link_health_result h where h.storage_object_id = o.id and h.detail->>'check' = 'rehash')`.as(
              'last_rehash',
            ),
          )
          .where('r.adapter', '=', 'managed_vault')
          .where('r.deleted_at', 'is', null)
          .where('o.deleted_at', 'is', null)
          .where('o.hash_source', '=', 'computed')
          .where('o.link_status', 'in', [...REHASH_STATUSES])
          .execute();
        const list = rows
          .filter((r) => r.last_rehash === null || r.last_rehash < since)
          .sort((a, b) => (a.last_rehash?.getTime() ?? 0) - (b.last_rehash?.getTime() ?? 0) || a.id.localeCompare(b.id))
          .slice(0, REHASH_BATCH);
        const repositories = new Map<string, Awaited<ReturnType<StorageGatewayContext['repository']>>>();
        for (const id of new Set(list.map((r) => r.storage_repository_id))) {
          repositories.set(id, await this.gatewayContext.repository(trx, await this.gatewayContext.repositoryRow(trx, id), { withCredential: false }));
        }
        return { list: list as (LinkObjectRow & { last_rehash: Date | null })[], repositories, tenant: await this.gatewayContext.tenant(trx, org.id) };
      },
      requestId,
    );
    const summary: RehashSummary = { due: due.list.length, matched: 0, mismatched: 0, skipped: 0 };
    const affected = new Set<string>();
    for (const object of due.list) {
      const repository = due.repositories.get(object.storage_repository_id)!;
      await this.pacer.take(repository.id, 'managed_vault');
      const ref: GatewayObjectRef = {
        externalItemId: object.external_item_id,
        externalVersionId: object.external_version_id,
        hashAlgorithm: object.hash_algorithm,
        hashValue: object.hash_value,
        hashSource: object.hash_source,
        folderPath: object.folder_path,
      };
      const at = windowNow(this.clock, org.timeZone);
      const base: Omit<Observation, 'outcome' | 'status' | 'reason' | 'verified' | 'found'> = {
        folderPath: null,
        alwaysRecord: true,
        at,
        jobId,
        source: 'integrity.rehash',
      };
      let observation: Observation;
      try {
        const result = await this.gateway.post<RehashResult>('/v1/rehash', { tenant: due.tenant, repository, object: ref }, { requestId });
        observation = {
          ...base,
          outcome: 'found',
          status: result.matches ? object.link_status : 'hash_mismatch',
          reason: result.matches ? object.link_status_reason : null,
          verified: false,
          found: true,
          observedHash: result.hashValue,
          detail: { check: 'rehash', matches: result.matches, ...(result.detail ? { reason: result.detail } : {}) },
        };
        if (result.matches) summary.matched += 1;
        else summary.mismatched += 1;
      } catch (error) {
        if (!(error instanceof GatewayProblemError)) throw error;
        // Not found, refused or unreachable: the status is the link check's business; the re-hash is retried next week.
        summary.skipped += 1;
        observation = {
          ...base,
          outcome: error.gatewaySlug === 'not-found' ? 'not_found' : error.gatewaySlug === 'unreachable' ? 'unreachable' : 'error',
          status: object.link_status,
          reason: object.link_status_reason,
          verified: false,
          found: false,
          detail: { check: 'rehash', problem: error.gatewaySlug },
        };
      }
      const applied = await this.runner.run(org, (trx) => this.writer.apply(trx, object, observation), requestId);
      if (applied.affectsValidity) for (const ms of applied.msIds) affected.add(ms);
    }
    if (affected.size > 0) {
      await this.runner.run(
        org,
        async (trx) => {
          for (const msId of affected) {
            await this.jobs.send(
              'freshness.recompute',
              { orgId: org.id, requestId, payload: { msId } },
              { singletonKey: freshnessRecomputeKey(org.id, msId), startAfterSeconds: FRESHNESS_RECOMPUTE_DELAY_SECONDS, retryLimit: 3 },
              trx,
            );
          }
        },
        requestId,
      );
    }
    if (summary.mismatched > 0) this.logger.warn({ orgId: org.id, mismatched: summary.mismatched }, 'integrity.rehash found changed vault content');
    return summary;
  }
}
