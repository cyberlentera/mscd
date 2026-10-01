// The metrics of ARCHITECTURE 12 that are read from the job queue and the database (WP-34): queue depth and age,
// storage objects by link status, licence days left per organisation, second-factor lockouts and stuck outbox
// rows. They are collected when Prometheus scrapes, from a snapshot that is at most `OPS_METRICS_TTL_MS` old, so
// frequent scrapes (or the api and the worker both being scraped) cost one round of queries per interval.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { LINK_STATUSES } from '@mscd/shared';
import { sql } from 'kysely';
import { JOB_QUEUE, type JobQueue, type QueueStats } from '../../common/jobs/job-queue';
import type { TenantInfo } from '../../common/tokens';
import { countStuckOutboxRows } from '../jobs/bullmq-job-queue';
import { LicenceService } from '../license/licence.service';
import { METRICS, registerCollected, type MetricSample } from '../observability/metric-catalogue';
import { MetricsService } from '../platform/metrics';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';

/** Longest age of the snapshot behind the collected metrics. */
export const OPS_METRICS_TTL_MS = 15_000;

/** An active organisation as the operator views list it. */
export interface ActiveOrganisation {
  id: string;
  slug: string;
  schema: string;
}

export interface OpsMetricsSnapshot {
  takenAt: Date;
  queues: QueueStats[];
  linkStatus: Record<string, number>;
  licenceDaysLeft: { org: string; days: number }[];
  mfaLocks: number;
  outbox: { stuckRows: number; oldestStuckAt: Date | null };
}

type Section = 'queues' | 'linkStatus' | 'licenceDaysLeft' | 'mfaLocks' | 'outbox';

@Injectable()
export class OpsMetricsCollector implements OnModuleInit {
  private readonly logger = new Logger('OpsMetrics');
  private snapshot: OpsMetricsSnapshot = { takenAt: new Date(0), queues: [], linkStatus: {}, licenceDaysLeft: [], mfaLocks: 0, outbox: { stuckRows: 0, oldestStuckAt: null } };
  private loadedAt = 0;
  private loading?: Promise<OpsMetricsSnapshot>;
  private readonly lastErrors = new Map<Section, string>();

  constructor(
    private readonly metrics: MetricsService,
    private readonly scope: TenantScope,
    private readonly licences: LicenceService,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  onModuleInit(): void {
    const registry = this.metrics.registry;
    registerCollected(registry, METRICS.queueWaiting, async () =>
      (await this.current()).queues.map((q) => ({ labels: { queue: q.name }, value: q.waiting })),
    );
    registerCollected(registry, METRICS.queueOldestAge, async () =>
      (await this.current()).queues.map((q) => ({ labels: { queue: q.name }, value: q.oldestAgeSeconds })),
    );
    registerCollected(registry, METRICS.linkStatusObjects, async () =>
      Object.entries((await this.current()).linkStatus).map(([status, value]): MetricSample => ({ labels: { status }, value })),
    );
    registerCollected(registry, METRICS.licenceDaysLeft, async () =>
      (await this.current()).licenceDaysLeft.map((l) => ({ labels: { org: l.org }, value: l.days })),
    );
    registerCollected(registry, METRICS.mfaLocks, async () => [{ labels: {}, value: (await this.current()).mfaLocks }]);
    registerCollected(registry, METRICS.outboxStuckRows, async () => [{ labels: {}, value: (await this.current()).outbox.stuckRows }]);
  }

  /** The snapshot, refreshed when older than the TTL (concurrent callers share one refresh). */
  async current(): Promise<OpsMetricsSnapshot> {
    if (Date.now() - this.loadedAt < OPS_METRICS_TTL_MS) return this.snapshot;
    return this.refresh();
  }

  /** Reads every section now; a section that fails keeps its previous values and is logged once per message. */
  refresh(): Promise<OpsMetricsSnapshot> {
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /** Active organisations (not deleted), in display order. */
  async activeOrganisations(): Promise<ActiveOrganisation[]> {
    const rows = await this.scope.withPlatform(
      (trx) =>
        trx
          .selectFrom('platform.organization')
          .select(['id', 'slug', 'schema_name'])
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .orderBy('position')
          .orderBy('slug')
          .execute(),
      { scope: 'operator' },
    );
    return rows.map((r) => ({ id: r.id, slug: r.slug, schema: r.schema_name }));
  }

  /** Queue statistics with whole counts (E.1 `stats()`). */
  async queueStats(): Promise<QueueStats[]> {
    const stats = await this.queue.stats();
    return stats.map((q) => ({
      name: q.name,
      waiting: Math.max(0, Math.trunc(q.waiting)),
      active: Math.max(0, Math.trunc(q.active)),
      failed: Math.max(0, Math.trunc(q.failed)),
      oldestAgeSeconds: Math.max(0, q.oldestAgeSeconds),
    }));
  }

  /** Days to `valid_until` and the state of the current licence of each active organisation that has one. */
  async licenceStates(orgs: readonly ActiveOrganisation[]): Promise<{ org: string; state: 'valid' | 'grace' | 'read_only'; validUntil: string | null; days: number }[]> {
    const out: { org: string; state: 'valid' | 'grace' | 'read_only'; validUntil: string | null; days: number }[] = [];
    for (const org of orgs) {
      const evaluated = await this.licences.evaluateOrg(org.id);
      if (!evaluated) continue;
      out.push({ org: org.slug, state: evaluated.state, validUntil: evaluated.document?.valid_until ?? null, days: evaluated.daysToExpiry });
    }
    return out;
  }

  /** Outbox rows stuck in or parked by the relay (BullMQ driver). */
  async outboxHealth(): Promise<{ stuckRows: number; oldestStuckAt: Date | null }> {
    const stuck = await this.scope.withPlatform((trx) => countStuckOutboxRows(trx), { scope: 'operator' });
    return { stuckRows: stuck.rows, oldestStuckAt: stuck.oldestCreatedAt };
  }

  private async load(): Promise<OpsMetricsSnapshot> {
    const next: OpsMetricsSnapshot = { ...this.snapshot, takenAt: new Date() };
    let orgs: ActiveOrganisation[] | null = null;
    const section = async <T>(name: Section, fn: () => Promise<T>, apply: (value: T) => void): Promise<void> => {
      try {
        apply(await fn());
        this.lastErrors.delete(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.lastErrors.get(name) !== message) this.logger.warn(`Metric section ${name} not refreshed: ${message}`);
        this.lastErrors.set(name, message);
      }
    };
    const organisations = async (): Promise<ActiveOrganisation[]> => (orgs ??= await this.activeOrganisations());
    await section('queues', () => this.queueStats(), (v) => (next.queues = v));
    await section('linkStatus', async () => this.linkStatusCounts(await organisations()), (v) => (next.linkStatus = v));
    await section('licenceDaysLeft', async () => (await this.licenceStates(await organisations())).map((l) => ({ org: l.org, days: l.days })), (v) => (next.licenceDaysLeft = v));
    await section('mfaLocks', () => this.mfaLockCount(), (v) => (next.mfaLocks = v));
    await section('outbox', () => this.outboxHealth(), (v) => (next.outbox = v));
    this.snapshot = next;
    this.loadedAt = Date.now();
    return next;
  }

  /** Storage objects (not deleted) by link status over every active organisation; every status is listed. */
  private async linkStatusCounts(orgs: readonly ActiveOrganisation[]): Promise<Record<string, number>> {
    const totals: Record<string, number> = Object.fromEntries(LINK_STATUSES.map((status) => [status, 0]));
    for (const org of orgs) {
      const info: Pick<TenantInfo, 'id' | 'schema'> = { id: org.id, schema: org.schema };
      const rows = await this.scope.withTenant(systemContextOf(info), (trx) =>
        trx
          .selectFrom('storage_object')
          .select((eb) => ['link_status', eb.fn.countAll<string>().as('n')])
          .where('deleted_at', 'is', null)
          .groupBy('link_status')
          .execute(),
      );
      for (const row of rows) totals[row.link_status] = (totals[row.link_status] ?? 0) + Number(row.n);
    }
    return totals;
  }

  /** `auth.mfa_locked` entries of the platform audit log: the installation's lockouts (append-only, so monotonic). */
  private async mfaLockCount(): Promise<number> {
    const row = await this.scope.withPlatform(
      (trx) => sql<{ n: string }>`select count(*)::text as n from platform.audit_log where action = 'auth.mfa_locked'`.execute(trx),
      { scope: 'operator' },
    );
    return Number(row.rows[0]?.n ?? 0);
  }
}
