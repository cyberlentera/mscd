// `drift.evaluate` (build plan E.2, TS 9.6, BR-48, BR-49): every drift rule of a computed kind of the system's
// edition is evaluated with the predicate of the same name the read model uses (`read-model/derive/drift.ts`):
// `stale_risk` (risk not assessed within `predicate.months`, default 12), `dd_expired` (business associate with a
// bribery risk level above `low` and no completed due diligence valid today), `metric` (not measured within its
// period), `exercise` (business continuity plan without an exercise planned or recently performed), `unverif` and
// `nohash` (the evidence integrity codes of C.12). A new match gets an open `drift_result` row (holder the record
// owner, due in 30 days, BR-48) and a `drift_detected` digest notification to the holder; an open row whose record
// no longer matches is resolved (BR-49). Rows of `manual` rules are never touched.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { addDays } from '../../common/dates';
import { AUDIT_WRITER, MEMBERSHIP_SERVICE, NOTIFICATION_WRITER, SYSTEM_USER_ID, type AuditWriter, type MembershipService, type NotificationWriter, type TenantInfo, type Trx } from '../../common/tokens';
import { windowNow } from '../jobs/job-support';
import { TenantJobRunner } from '../jobs/tenant-job';
import {
  integOf,
  isStaleMetric,
  isStaleRisk,
  isUnverifiable,
  lacksScheduledExercise,
  lacksValidDueDiligence,
  type DriftRuleDefRow,
  type StorageObjectState,
} from '../read-model';

/** BR-48: a drift row is due 30 days after it is detected. */
export const DRIFT_DUE_DAYS = 30;

type ComputedKind = Exclude<DriftRuleDefRow['sourceKind'], 'manual'>;

/** A record that matches a drift rule. */
export interface DriftMatch {
  entityType: string;
  entityId: string;
  entityCode: string;
  title: string;
  holderUserId: string | null;
}

export interface DriftSummary {
  systems: number;
  rules: number;
  detected: number;
  resolved: number;
  open: number;
}

interface SystemRow {
  id: string;
  slug: string;
  framework_version_id: string;
}

interface DefRow {
  id: string;
  code: string;
  label_en: string;
  label_id: string;
  source_kind: ComputedKind;
  predicate: Record<string, unknown> | null;
}

/** Bribery risk levels that need no due diligence (`ref.lookup_value` domain `bribery_risk_level`). */
const LOW_BRIBERY_RISK = new Set(['low']);

@Injectable()
export class DriftService {
  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
  ) {}

  async evaluate(org: TenantInfo, scope: { msId?: string }, requestId?: string): Promise<DriftSummary> {
    const at = windowNow(this.clock, org.timeZone);
    const today = this.clock.todayIn(org.timeZone);
    return this.runner.run(
      org,
      async (trx) => {
        const summary: DriftSummary = { systems: 0, rules: 0, detected: 0, resolved: 0, open: 0 };
        let systems = trx
          .selectFrom('management_system')
          .select(['id', 'slug', 'framework_version_id'])
          .where('deleted_at', 'is', null)
          .where('status', '<>', 'archived');
        if (scope.msId) systems = systems.where('id', '=', scope.msId);
        for (const system of await systems.orderBy('position').execute()) {
          summary.systems += 1;
          const defs = (await trx
            .selectFrom('ref.drift_rule_def')
            .select(['id', 'code', 'label_en', 'label_id', 'source_kind', 'predicate'])
            .where('framework_version_id', '=', system.framework_version_id)
            .where('source_kind', '<>', 'manual')
            .orderBy('sort_order')
            .orderBy('code')
            .execute()) as DefRow[];
          for (const def of defs) {
            summary.rules += 1;
            const matches = await this.matches(trx, system, def, today);
            const result = await this.store(trx, system, def, matches, today, at);
            summary.detected += result.detected;
            summary.resolved += result.resolved;
            summary.open += result.open;
          }
        }
        return summary;
      },
      requestId,
    );
  }

  /** The records of one system that match a computed rule today. */
  async matches(trx: Trx, system: SystemRow, def: DefRow, today: string): Promise<DriftMatch[]> {
    switch (def.source_kind) {
      case 'stale_risk': {
        const months = typeof def.predicate?.months === 'number' && def.predicate.months > 0 ? def.predicate.months : 12;
        const risks = await sql<{ id: string; code: string; title: string; owner_user_id: string | null; assessed_at: string | null }>`
          select r.id, r.code, r.title, r.owner_user_id, r.assessed_at::text as assessed_at from risk r
          where r.deleted_at is null and exists (
            select 1 from entity_ms_link l where l.entity_type = 'risk' and l.entity_id = r.id and l.deleted_at is null
              and l.management_system_id = ${system.id}::uuid)
          order by r.position, r.code`.execute(trx);
        return risks.rows
          .filter((r) => isStaleRisk({ assessedAt: r.assessed_at }, today, months))
          .map((r) => ({ entityType: 'risk', entityId: r.id, entityCode: r.code, title: r.title, holderUserId: r.owner_user_id }));
      }
      case 'dd_expired': {
        const associates = await sql<{ id: string; code: string; title: string; holder: string | null; level: string | null }>`
          select a.id, a.code, a.title, coalesce(a.relationship_owner_user_id, a.owner_user_id) as holder, a.bribery_risk_level as level
          from business_associate a
          where a.deleted_at is null and a.management_system_id = ${system.id}::uuid
          order by a.position, a.code`.execute(trx);
        const risky = associates.rows.filter((a) => a.level !== null && !LOW_BRIBERY_RISK.has(a.level));
        if (risky.length === 0) return [];
        const checks = await sql<{ subject_id: string; status: string; valid_until: string | null }>`
          select d.subject_id, d.status, d.valid_until::text as valid_until from due_diligence d
          where d.deleted_at is null and d.subject_type = 'associate' and d.subject_id = any(${sql`${risky.map((a) => a.id)}::uuid[]`})`.execute(trx);
        return risky
          .filter((a) => lacksValidDueDiligence(checks.rows.filter((c) => c.subject_id === a.id).map((c) => ({ status: c.status, validUntil: c.valid_until })), today))
          .map((a) => ({ entityType: 'business_associate', entityId: a.id, entityCode: a.code, title: a.title, holderUserId: a.holder }));
      }
      case 'metric': {
        const metrics = await sql<{ id: string; code: string; title: string; owner_user_id: string | null; last_measured_at: string | null; period_days: number | null }>`
          select m.id, m.code, m.title, m.owner_user_id, m.last_measured_at::text as last_measured_at, f.period_days
          from metric m
          left join ref.evidence_frequency_rule f on f.framework_version_id = ${system.framework_version_id}::uuid and f.code = m.frequency_code
          where m.deleted_at is null and exists (
            select 1 from entity_ms_link l where l.entity_type = 'metric' and l.entity_id = m.id and l.deleted_at is null
              and l.management_system_id = ${system.id}::uuid)
          order by m.position, m.code`.execute(trx);
        return metrics.rows
          .filter((m) => isStaleMetric({ lastMeasuredAt: m.last_measured_at, periodDays: m.period_days ?? 0 }, today))
          .map((m) => ({ entityType: 'metric', entityId: m.id, entityCode: m.code, title: m.title, holderUserId: m.owner_user_id }));
      }
      case 'exercise': {
        const plans = await sql<{ id: string; code: string; title: string; owner_user_id: string | null }>`
          select p.id, p.code, p.title, p.owner_user_id from bc_plan p
          where p.deleted_at is null and p.management_system_id = ${system.id}::uuid order by p.position, p.code`.execute(trx);
        if (plans.rows.length === 0) return [];
        const exercises = await sql<{ bc_plan_id: string; planned_at: string | null; performed_at: string | null }>`
          select x.bc_plan_id, x.planned_at::text as planned_at, x.performed_at::text as performed_at from exercise x
          where x.deleted_at is null and x.bc_plan_id = any(${sql`${plans.rows.map((p) => p.id)}::uuid[]`})`.execute(trx);
        return plans.rows
          .filter((p) =>
            lacksScheduledExercise(
              exercises.rows.filter((x) => x.bc_plan_id === p.id).map((x) => ({ plannedAt: x.planned_at, performedAt: x.performed_at })),
              today,
            ),
          )
          .map((p) => ({ entityType: 'bc_plan', entityId: p.id, entityCode: p.code, title: p.title, holderUserId: p.owner_user_id }));
      }
      case 'unverif':
      case 'nohash': {
        const evidence = await sql<{
          id: string;
          evidence_code: string;
          title: string;
          owner_user_id: string | null;
          link_status: StorageObjectState['linkStatus'] | null;
          hash_algorithm: StorageObjectState['hashAlgorithm'] | null;
          hash_source: StorageObjectState['hashSource'] | null;
          link_status_since: Date | null;
          link_status_reason: StorageObjectState['linkStatusReason'];
        }>`
          select e.id, e.evidence_code, e.title, e.owner_user_id, o.link_status, o.hash_algorithm, o.hash_source, o.link_status_since, o.link_status_reason
          from evidence e
          left join storage_object o on o.id = e.storage_object_id and o.deleted_at is null
          where e.deleted_at is null and exists (
            select 1 from evidence_target t where t.evidence_id = e.id and t.deleted_at is null and t.management_system_id = ${system.id}::uuid)
          order by e.position, e.evidence_code`.execute(trx);
        return evidence.rows
          .filter((e) => {
            const state: StorageObjectState | null = e.link_status
              ? { linkStatus: e.link_status, hashAlgorithm: e.hash_algorithm!, hashSource: e.hash_source!, linkStatusSince: e.link_status_since!, linkStatusReason: e.link_status_reason }
              : null;
            const integ = integOf(state);
            return def.source_kind === 'unverif' ? isUnverifiable(integ) : integ === 'nohash';
          })
          .map((e) => ({ entityType: 'evidence', entityId: e.id, entityCode: e.evidence_code, title: e.title, holderUserId: e.owner_user_id }));
      }
    }
  }

  /** BR-48 and BR-49 for one rule of one system: open rows for new matches, resolve rows that no longer match. */
  private async store(trx: Trx, system: SystemRow, def: DefRow, matches: readonly DriftMatch[], today: string, at: Date) {
    const open = await trx
      .selectFrom('drift_result')
      .select(['id', 'entity_id', 'entity_code', 'position'])
      .where('management_system_id', '=', system.id)
      .where('rule_code', '=', def.code)
      .where('resolved_at', 'is', null)
      .where('deleted_at', 'is', null)
      .execute();
    const matchIds = new Set(matches.map((m) => m.entityId));
    const matchCodes = new Set(matches.map((m) => m.entityCode));
    const stillOpen = (row: (typeof open)[number]) => (row.entity_id ? matchIds.has(row.entity_id) : matchCodes.has(row.entity_code));
    const coveredIds = new Set(open.filter((r) => r.entity_id).map((r) => r.entity_id!));
    const coveredCodes = new Set(open.filter((r) => !r.entity_id).map((r) => r.entity_code));
    let position = open.reduce((max, r) => Math.max(max, r.position), -1);
    let detected = 0;
    for (const match of matches) {
      if (coveredIds.has(match.entityId) || coveredCodes.has(match.entityCode)) continue;
      const holder = match.holderUserId && (await this.members.isMember(trx, match.holderUserId)) ? match.holderUserId : null;
      position += 1;
      const row = await trx
        .insertInto('drift_result')
        .values({
          management_system_id: system.id,
          drift_rule_def_id: def.id,
          rule_code: def.code,
          entity_type: match.entityType,
          entity_id: match.entityId,
          entity_code: match.entityCode.slice(0, 40),
          title: match.title,
          holder_user_id: holder,
          due_at: addDays(today, DRIFT_DUE_DAYS),
          detected_at: at,
          position,
          created_by: SYSTEM_USER_ID,
          updated_by: SYSTEM_USER_ID,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      detected += 1;
      await this.audit.record(trx, {
        action: 'register.created',
        actor: { userId: SYSTEM_USER_ID, kind: 'system' },
        msId: system.id,
        entityType: 'drift_result',
        entityId: row.id,
        entityCode: match.entityCode.slice(0, 80),
        after: { rule: def.code, kind: def.source_kind, entityType: match.entityType, entityId: match.entityId, dueAt: addDays(today, DRIFT_DUE_DAYS) },
      });
      if (holder) {
        await this.notifications.create(trx, {
          recipientUserId: holder,
          kind: 'drift_detected',
          msId: system.id,
          digest: true,
          createdBy: SYSTEM_USER_ID,
          title: { en: `${def.label_en}: ${match.entityCode}`, id: `${def.label_id}: ${match.entityCode}` },
          body: {
            en: `${match.entityCode} ${match.title} matches the regression rule "${def.label_en}". Resolve it by ${addDays(today, DRIFT_DUE_DAYS)} (BR-48).`,
            id: `${match.entityCode} ${match.title} cocok dengan aturan regresi "${def.label_id}". Selesaikan paling lambat ${addDays(today, DRIFT_DUE_DAYS)} (BR-48).`,
          },
          ref: { module: 'surveillance', entityType: 'drift_result', id: row.id, code: match.entityCode.slice(0, 80) },
        });
      }
    }
    const cleared = open.filter((row) => !stillOpen(row));
    for (const row of cleared) {
      await trx
        .updateTable('drift_result')
        .set({ resolved_at: at, updated_at: sql<Date>`now()`, updated_by: SYSTEM_USER_ID })
        .where('id', '=', row.id)
        .execute();
      await this.audit.record(trx, {
        action: 'register.updated',
        actor: { userId: SYSTEM_USER_ID, kind: 'system' },
        msId: system.id,
        entityType: 'drift_result',
        entityId: row.id,
        entityCode: row.entity_code,
        before: { resolvedAt: null },
        after: { resolvedAt: at.toISOString(), reason: 'BR-49 condition cleared' },
      });
    }
    return { detected, resolved: cleared.length, open: open.length - cleared.length + detected };
  }
}
