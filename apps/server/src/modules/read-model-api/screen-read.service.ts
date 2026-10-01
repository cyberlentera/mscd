// The per-screen read endpoints of TS 9.2 (build plan D.3 "Read model per screen", WP-32): one tenant transaction per
// request loads the system with the WP-17 loader, derives its snapshot with `buildSystemSnapshot` on the full data
// (D-04), applies `ScopePolicy.projectSnapshot` for the caller (owner scope, classification, the external auditor
// projection), and hands both to the projections in `screens.ts`. The few stored fields the snapshot does not
// carry (event type and outcome, drift severity and message, activity clause and outcome, evidence targets, BR-43
// flags) are read in the same transaction.
import { Inject, Injectable } from '@nestjs/common';
import {
  type ActivityItem, type ApplicabilityItem, type ApplicabilityQuery, type BusinessRole, type ChainResponse, type CycleItem, type DocumentItem,
  type DocumentsQuery, type DriftPattern, type EvidenceItem, type EvidenceQuery, type GateItemView, type ImplementationSummary, type NextAuditEvent,
  type Page, type PendingAggregate, type PendingPerson, type PendingQuery, type PendingRecord, type Permission, type StageReadiness,
  type StageRecordsQuery, type SurveillanceEvent,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { ForbiddenError, NotFoundError } from '../../common/problems';
import { PERMISSION_EVALUATOR, type PermissionEvaluator, type Principal, type TenantInfo, type Trx } from '../../common/tokens';
import { ScopePolicyService } from '../authz/scope-policy';
import { ActivityService } from '../implementation';
import { buildSystemSnapshot, loadOrgData, systemFields } from '../read-model';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import {
  applicabilityPage, chainFrom, cycleItems, documentsPage, driftPatterns, evidencePage, gateItems, implementationSummary, nextAuditEvent,
  pendingAggregate, pendingOf, pendingPerPerson, phaseActivities, stageReadiness, stageRecordsPage, surveillanceEvent,
  type ActivityDetail, type DriftRuleDetail, type EventDetail, type FindingDetail, type Person, type PrepDetail, type RepositoryNames,
  type ScreenData,
} from './screens';
import type { Lang } from './texts';

type BuildContext = Parameters<typeof buildSystemSnapshot>[1];

@Injectable()
export class ScreenReadService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly scopePolicy: ScopePolicyService,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    private readonly activityCommands: ActivityService,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // Module 1
  // -------------------------------------------------------------------------------------------------------------

  /**
   * The summary, plus the BR-46 gate consistency flag (`ActivityService.gateConsistencyIn`, WP-20) for readers with
   * the full view of the system; owner-scoped, Top Management and external auditor readers get the cards only.
   */
  summary(principal: Principal, ms: string, lang: Lang): Promise<ImplementationSummary> {
    const org = this.orgOf(principal);
    return this.screen(principal, ms, lang, async (trx, d) => {
      const summary = implementationSummary(d);
      if (d.scope.kind !== 'full') return summary;
      const consistency = await this.activityCommands.gateConsistencyIn(trx, org, ms);
      return {
        ...summary,
        gateConsistency: {
          gatePhases: consistency.gatePhases,
          blockedActivities: consistency.blockedActivities,
          openGateItems: consistency.openGateItems,
          flagged: consistency.finding !== null,
          ...(consistency.finding ? { messages: consistency.finding.messages } : {}),
        },
      };
    });
  }

  applicability(principal: Principal, ms: string, lang: Lang, query: ApplicabilityQuery): Promise<Page<ApplicabilityItem>> {
    return this.screen(principal, ms, lang, async (trx, d) => applicabilityPage(d, query, await this.entryEvidence(trx, d.system.id)));
  }

  documents(principal: Principal, ms: string, lang: Lang, query: DocumentsQuery): Promise<Page<DocumentItem>> {
    return this.screen(principal, ms, lang, async (_trx, d) => documentsPage(d, query));
  }

  gates(principal: Principal, ms: string, lang: Lang): Promise<GateItemView[]> {
    return this.screen(principal, ms, lang, async (_trx, d) => gateItems(d));
  }

  activities(principal: Principal, ms: string, lang: Lang, n: number): Promise<ActivityItem[]> {
    return this.screen(principal, ms, lang, async (trx, d) => phaseActivities(d, n, await this.activityDetails(trx, d.system.id, n)));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Module 2
  // -------------------------------------------------------------------------------------------------------------

  nextEvent(principal: Principal, ms: string, lang: Lang): Promise<NextAuditEvent | null> {
    return this.screen(principal, ms, lang, async (trx, d) => nextAuditEvent(d, await this.eventDetails(trx, d.system.id)));
  }

  stages(principal: Principal, ms: string, lang: Lang): Promise<StageReadiness[]> {
    return this.screen(principal, ms, lang, async (_trx, d) => stageReadiness(d));
  }

  stageRecords(principal: Principal, ms: string, lang: Lang, key: string, query: StageRecordsQuery): Promise<Page<PendingRecord>> {
    return this.screen(principal, ms, lang, async (trx, d) => stageRecordsPage(d, key, query, await this.repositoryNames(trx)));
  }

  chain(principal: Principal, ms: string, lang: Lang, anchor: string): Promise<ChainResponse> {
    return this.screen(principal, ms, lang, async (_trx, d) => chainFrom(d, anchor));
  }

  /**
   * `GET /ms/{ms}/audit/pending` (D.3): with `owner` one person's records (anyone may read their own; another
   * person's need `audit.pending.all`); without it everyone's list per person (`audit.pending.all`); with
   * `aggregate=unit` counts per stage and role without names (`audit.pending.aggregate`, Top Management).
   */
  async pending(principal: Principal, ms: string, lang: Lang, query: PendingQuery): Promise<PendingPerson[] | Page<PendingRecord> | PendingAggregate[]> {
    const filter = { stage: query.stage, overdueOnly: query.overdue_only };
    if (query.aggregate === 'unit') {
      await this.require(principal, ms, 'audit.pending.aggregate', 'Pending counts per unit need audit.pending.aggregate');
      return this.screen(principal, ms, lang, async (trx, d) => pendingAggregate(d, filter, await this.rolesByHandle(trx, d.system.id)));
    }
    if (query.owner) {
      if (query.owner !== principal.user.handle) {
        await this.require(principal, ms, 'audit.pending.all', "Another person's pending items need audit.pending.all");
      }
      const owner = query.owner;
      return this.screen(principal, ms, lang, async (trx, d) => pendingOf(d, owner, filter, query, await this.repositoryNames(trx)));
    }
    await this.require(principal, ms, 'audit.pending.all', "Everyone's pending items need audit.pending.all");
    return this.screen(principal, ms, lang, async (_trx, d) => pendingPerPerson(d, filter));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Module 3
  // -------------------------------------------------------------------------------------------------------------

  event(principal: Principal, ms: string, lang: Lang, id: string): Promise<SurveillanceEvent> {
    return this.screen(principal, ms, lang, async (trx, d) => {
      const details = await this.eventDetails(trx, d.system.id);
      if (!d.system.events.some((e) => e.id === id)) throw new NotFoundError('Unknown audit event');
      return surveillanceEvent(d, id, details, await this.prepDetails(trx, id), await this.findingDetails(trx, d.system.id));
    });
  }

  cycle(principal: Principal, ms: string, lang: Lang, cycleId: string | undefined): Promise<CycleItem[]> {
    return this.screen(principal, ms, lang, async (_trx, d) => cycleItems(d, cycleId));
  }

  drift(principal: Principal, ms: string, lang: Lang, rule: string | undefined): Promise<DriftPattern[]> {
    return this.screen(principal, ms, lang, async (trx, d) => driftPatterns(d, rule, await this.driftDetails(trx, d.system.active.id)));
  }

  evidence(principal: Principal, ms: string, lang: Lang, query: EvidenceQuery): Promise<Page<EvidenceItem>> {
    return this.screen(principal, ms, lang, async (_trx, d) => evidencePage(d, query));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------------------------

  private orgOf(principal: Principal): TenantInfo {
    if (!principal.org) throw new NotFoundError('No organisation is selected');
    return principal.org;
  }

  private async require(principal: Principal, ms: string, permission: Permission, detail: string): Promise<void> {
    if ((await this.evaluator.evaluate(principal, permission, { scope: 'ms', ms })) === null) throw new ForbiddenError(detail);
  }

  /** Loads, derives and scopes one system in a tenant transaction, then runs a projection on it. */
  private screen<T>(principal: Principal, ms: string, lang: Lang, project: (trx: Trx, data: ScreenData) => Promise<T>): Promise<T> {
    const org = this.orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const scope = await this.scopePolicy.scopeContext(trx, principal, ms);
      const now = this.clock.now();
      const today = this.clock.todayIn(org.timeZone);
      const loaded = await loadOrgData(trx, { slugs: [ms], bundle: true, now });
      const system = loaded.systems[0];
      if (!system?.bundle) throw new NotFoundError('Unknown management system');
      const people = await this.members(trx, org.id);
      const codes = await trx.selectFrom('management_system').select(['id', 'code']).where('deleted_at', 'is', null).execute();
      const ctx: BuildContext = {
        today,
        now,
        timeZone: org.timeZone,
        people: new Map([...people].map(([handle, p]) => [handle, p.name])),
        systemCodes: new Map(codes.map((c) => [c.id, c.code])),
      };
      const full = buildSystemSnapshot(system, ctx);
      const fields = systemFields(system, today);
      const data: ScreenData = {
        ms,
        lang,
        today,
        now,
        scope,
        system: system as ScreenData['system'],
        full,
        view: this.scopePolicy.projectSnapshot(scope, full),
        people,
        unit: fields.unit,
        gateName: fields.gateName,
        documentVisible: (code) => this.scopePolicy.documentVisible(scope, code),
        evidenceVisible: (code) => this.scopePolicy.evidenceVisible(scope, code),
      };
      return project(trx, data);
    });
  }

  /** Active members of the organisation with display names and job titles. */
  private async members(trx: Trx, orgId: string): Promise<Map<string, Person>> {
    const { rows } = await sql<{ handle: string; display_name: string; job_title: string | null }>`
      select u.handle, u.display_name, u.job_title
      from platform.org_membership m
      join platform.app_user u on u.id = m.user_id and u.deleted_at is null
      where m.organization_id = ${orgId}::uuid and m.deleted_at is null and m.status = 'active' and u.status = 'active'
      order by u.handle`.execute(trx);
    return new Map(rows.map((r) => [r.handle, { name: r.display_name, jobTitle: r.job_title }]));
  }

  /** Active business roles in the system by holder handle (pending aggregates). */
  private async rolesByHandle(trx: Trx, msId: string): Promise<Map<string, BusinessRole[]>> {
    const { rows } = await sql<{ handle: string; roles: BusinessRole[] }>`
      select u.handle, array_agg(distinct r.role) as roles
      from user_ms_role r
      join platform.app_user u on u.id = r.user_id and u.deleted_at is null
      where r.management_system_id = ${msId}::uuid and r.deleted_at is null and r.approval_status = 'active'
        and (r.valid_until is null or r.valid_until > ${this.clock.now()})
      group by u.handle`.execute(trx);
    return new Map(rows.map((r) => [r.handle, r.roles]));
  }

  /** Evidence ids by applicability entry of the system (`evidence_target`). */
  private async entryEvidence(trx: Trx, msId: string): Promise<Map<string, string[]>> {
    const { rows } = await sql<{ entry_id: string; evidence_id: string }>`
      select t.applicability_entry_id as entry_id, t.evidence_id
      from evidence_target t join evidence e on e.id = t.evidence_id and e.deleted_at is null
      where t.management_system_id = ${msId}::uuid and t.deleted_at is null
      order by t.position, t.created_at`.execute(trx);
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.entry_id) ?? [];
      list.push(r.evidence_id);
      out.set(r.entry_id, list);
    }
    return out;
  }

  private async activityDetails(trx: Trx, msId: string, phaseNo: number): Promise<ActivityDetail[]> {
    const { rows } = await sql<{ phase_no: number; activity_no: number; clause_ref: string | null; expected_outcome: string | null }>`
      select phase_no, activity_no, clause_ref, expected_outcome from implementation_activity_progress
      where management_system_id = ${msId}::uuid and phase_no = ${phaseNo} and deleted_at is null`.execute(trx);
    return rows.map((r) => ({ phaseNo: Number(r.phase_no), activityNo: Number(r.activity_no), clauseRef: r.clause_ref, expectedOutcome: r.expected_outcome }));
  }

  private async eventDetails(trx: Trx, msId: string): Promise<EventDetail[]> {
    const { rows } = await sql<{ id: string; event_type: EventDetail['type']; outcome: EventDetail['outcome'] }>`
      select id, event_type, outcome from audit_event where management_system_id = ${msId}::uuid and deleted_at is null`.execute(trx);
    return rows.map((r) => ({ id: r.id, type: r.event_type, outcome: r.outcome }));
  }

  private async prepDetails(trx: Trx, eventId: string): Promise<PrepDetail[]> {
    const { rows } = await sql<{
      id: string; updated_at: Date; title: string; owner: string | null; due_at: string; status: PrepDetail['status']; violates_br43: boolean;
    }>`
      select p.id, p.updated_at, p.title, (select u.handle from platform.app_user u where u.id = p.owner_user_id) as owner,
             p.due_at, p.status, p.violates_br43
      from audit_prep_task p
      where p.audit_event_id = ${eventId}::uuid and p.deleted_at is null
      order by p.position, p.due_at`.execute(trx);
    return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at, title: r.title, owner: r.owner, dueAt: r.due_at, status: r.status, violatesBr43: r.violates_br43 }));
  }

  private async findingDetails(trx: Trx, msId: string): Promise<FindingDetail[]> {
    const { rows } = await sql<{
      id: string; updated_at: Date; code: string; classification: FindingDetail['classification']; clause_ref: string | null; title: string;
      status: FindingDetail['status']; status_note: string | null; source: string; audit_event_id: string | null; owner: string | null;
    }>`
      select f.id, f.updated_at, f.code, f.classification, f.clause_ref, f.title, f.status, f.status_note, f.source, f.audit_event_id,
             (select u.handle from platform.app_user u where u.id = f.owner_user_id) as owner
      from finding f
      where f.management_system_id = ${msId}::uuid and f.deleted_at is null
      order by f.position, f.code`.execute(trx);
    return rows.map((r) => ({
      id: r.id, updatedAt: r.updated_at, code: r.code, classification: r.classification, clauseRef: r.clause_ref, title: r.title, status: r.status,
      statusNote: r.status_note, source: r.source, auditEventId: r.audit_event_id, owner: r.owner,
    }));
  }

  private async driftDetails(trx: Trx, frameworkVersionId: string): Promise<DriftRuleDetail[]> {
    const { rows } = await sql<{ code: string; severity: DriftRuleDetail['severity']; message: string }>`
      select code, severity, message from ref.drift_rule_def where framework_version_id = ${frameworkVersionId}::uuid`.execute(trx);
    return rows;
  }

  private async repositoryNames(trx: Trx): Promise<RepositoryNames> {
    const rows = await trx.selectFrom('storage_repository').select(['slug', 'name']).where('deleted_at', 'is', null).execute();
    return new Map(rows.map((r) => [r.slug, r.name]));
  }
}
