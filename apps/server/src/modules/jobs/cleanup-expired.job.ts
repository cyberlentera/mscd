// `cleanup.expired` (E.2): hourly at minute 20 UTC, installation-wide. Deletes expired rate limit buckets,
// idempotency keys, sign-in and link transactions and SAML assertion ids, and relayed outbox rows older than 7 days;
// revokes expired sessions; marks expired upload intents (`expired`) and export files (soft-deleted) in every
// organisation, and runs the tenant cleanup steps other modules register (`TenantCleanupRegistry`, for example the
// closing of expired guest auditor grants, F.14 step 5) in every active organisation. Every statement is idempotent.
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { SYSTEM_USER_ID } from '../../common/tokens';
import { RateLimitBucketStore } from '../tenancy/rate-limit-store';
import { TENANT_SCHEMA, TenantScope } from '../tenancy/tenant-scope';
import { TenantCleanupRegistry } from './tenant-cleanup';

/** Relayed outbox rows are kept this long (E.2). */
export const OUTBOX_RETENTION_DAYS = 7;

export interface CleanupResult {
  rateLimitBuckets: number;
  idempotencyKeys: number;
  authTransactions: number;
  samlAssertions: number;
  outboxRows: number;
  sessionsRevoked: number;
  uploadIntentsExpired: number;
  exportFilesExpired: number;
  /** Records ended or changed by each registered tenant cleanup step, summed over the organisations. */
  tenantSteps: Record<string, number>;
  /** Organisations whose tenant cleanup failed (the others are still cleaned). */
  failedOrganisations: string[];
}

@Injectable()
@JobHandler('cleanup.expired', { concurrency: 1, scope: 'installation' })
export class CleanupExpiredJob implements JobHandlerInstance<'cleanup.expired'> {
  private readonly logger = new Logger('cleanup.expired');

  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly rateLimits: RateLimitBucketStore,
    private readonly tenantSteps: TenantCleanupRegistry,
  ) {}

  async handle(job: JobRun<'cleanup.expired'>): Promise<void> {
    const result = await this.cleanup(job.env.requestId);
    this.logger.log({ jobId: job.id, attempt: job.attempt, ...result }, 'cleanup.expired done');
    if (result.failedOrganisations.length > 0) {
      throw new Error(`cleanup.expired failed for ${result.failedOrganisations.length} organisation(s): ${result.failedOrganisations.join(', ')}`);
    }
  }

  async cleanup(requestId?: string): Promise<CleanupResult> {
    const now = this.clock.now();
    const rateLimitBuckets = await this.rateLimits.purgeExpired();
    const platform = await this.scope.withPlatform(
      async (trx) => {
        const del = async (query: { executeTakeFirst(): Promise<{ numDeletedRows: bigint }> }) => Number((await query.executeTakeFirst()).numDeletedRows);
        const authTransactions = await del(trx.deleteFrom('platform.auth_transaction').where('expires_at', '<=', now));
        const samlAssertions = await del(trx.deleteFrom('platform.saml_assertion_seen').where('expires_at', '<=', now));
        const outboxRows = await del(
          trx
            .deleteFrom('platform.job_outbox')
            .where('dispatched_at', 'is not', null)
            .where('dispatched_at', '<=', sql<Date>`${now}::timestamptz - ${OUTBOX_RETENTION_DAYS} * interval '1 day'`),
        );
        const revoked = await trx
          .updateTable('platform.session')
          .set({ revoked_at: now, revoke_reason: 'expired' })
          .where('revoked_at', 'is', null)
          .where((eb) => eb.or([eb('idle_expires_at', '<=', now), eb('absolute_expires_at', '<=', now)]))
          .executeTakeFirst();
        const orgs = await trx
          .selectFrom('platform.organization')
          .select(['id', 'schema_name', 'deleted_at', 'status'])
          .where(sql<boolean>`to_regnamespace(schema_name) IS NOT NULL`)
          .orderBy('position')
          .orderBy('slug')
          .execute();
        return { authTransactions, samlAssertions, outboxRows, sessionsRevoked: Number(revoked.numUpdatedRows), orgs };
      },
      { scope: 'job', requestId },
    );

    let idempotencyKeys = 0;
    let uploadIntentsExpired = 0;
    let exportFilesExpired = 0;
    const steps = this.tenantSteps.list();
    const tenantSteps: Record<string, number> = Object.fromEntries(steps.map((step) => [step.name, 0]));
    const failedOrganisations: string[] = [];
    for (const org of platform.orgs) {
      try {
        // `idempotency_key` is visible per organisation only (its RLS has no platform scope, C.4).
        idempotencyKeys += await this.scope.withPlatform(
          async (trx) => Number((await trx.deleteFrom('platform.idempotency_key').where('expires_at', '<=', now).executeTakeFirst()).numDeletedRows),
          { scope: 'job', orgId: org.id, requestId },
        );
        if (org.deleted_at !== null || !TENANT_SCHEMA.test(org.schema_name)) continue;
        const tenantContext = { orgId: org.id, schema: org.schema_name, userId: SYSTEM_USER_ID, requestId };
        const tenant = await this.scope.withTenant(tenantContext, async (trx) => {
          const intents = await trx
            .updateTable('upload_intent')
            .set({ status: 'expired', updated_at: now, updated_by: SYSTEM_USER_ID })
            .where('status', '=', 'open')
            .where('expires_at', '<=', now)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          const exportsExpired = await trx
            .updateTable('export_file')
            .set({ deleted_at: now, updated_at: now, updated_by: SYSTEM_USER_ID })
            .where('deleted_at', 'is', null)
            .where('expires_at', '<=', now)
            .executeTakeFirst();
          return { intents: Number(intents.numUpdatedRows), exports: Number(exportsExpired.numUpdatedRows) };
        });
        uploadIntentsExpired += tenant.intents;
        exportFilesExpired += tenant.exports;
        // Registered steps run for active organisations only (a suspended one keeps its state until it returns), each
        // in its own tenant transaction, so a failing step rolls back neither the expiries above nor the other steps.
        if (org.status === 'active') {
          let stepFailed = false;
          for (const step of steps) {
            try {
              tenantSteps[step.name] = (tenantSteps[step.name] ?? 0) + (await this.scope.withTenant(tenantContext, (trx) => step.run(trx, org.id, now)));
            } catch (error) {
              stepFailed = true;
              this.logger.error({ orgId: org.id, step: step.name, error: (error as Error).message }, 'cleanup.expired step failed for an organisation');
            }
          }
          if (stepFailed) failedOrganisations.push(org.id);
        }
      } catch (error) {
        failedOrganisations.push(org.id);
        this.logger.error({ orgId: org.id, error: (error as Error).message }, 'cleanup.expired failed for an organisation');
      }
    }
    return {
      rateLimitBuckets,
      idempotencyKeys,
      authTransactions: platform.authTransactions,
      samlAssertions: platform.samlAssertions,
      outboxRows: platform.outboxRows,
      sessionsRevoked: platform.sessionsRevoked,
      uploadIntentsExpired,
      exportFilesExpired,
      tenantSteps,
      failedOrganisations,
    };
  }
}
