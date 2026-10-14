// Register rows of the risk side (D.3 "Registers and workflows: risk side", WP-36): lists of context issues,
// interested parties, assets, risks and metrics filtered by `ScopePolicy`, creation and change of rows (shareable
// kinds with their `entity_ms_link` rows, A-29; lookups checked against the edition's reference data; BR-17 for
// risks; BR-22 confirmation for rows shared by several systems; `integrated_mode` for a second system), and metric
// values. Every command resolves records through `RecordResolver`, people through `MembershipService`, honours
// `If-Match` where the route asks for it and writes its audit entry in the same transaction.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  REGISTER_ENTITY_TYPES,
  type CommandResult,
  type MetricValueRequest,
  type Page,
  type RegisterCreate,
  type RegisterItem,
  type RegisterKind,
  type RegisterListQuery,
  type RegisterPatch,
  type ShareableEntityType,
} from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import { fmtDay } from '../../common/dates';
import { assertIfMatch } from '../../common/etag';
import { ConflictError, ForbiddenError, ValidationError } from '../../common/problems';
import {
  AUDIT_WRITER, LICENCE_GATE, MEMBERSHIP_SERVICE, RECORD_RESOLVER, SCOPE_POLICY, type AuditWriter, type AuthzState, type LicenceGate,
  type MembershipService, type MsRef, type Principal, type RecordResolver, type ScopePolicy, type Trx,
} from '../../common/tokens';
import { RuleEngine } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { confirmShared, type Br17Input } from './rules';
import {
  assertFrequency, bump, commandResult, duplicateCode, editionOf, grantedInFull, linksOf, orgOf, refOf, unprocessable, type LinkRow,
} from './support';

/** Chain record text of a new risk until a treatment is linked (the sample's wording, UI 1.8). */
export const RISK_NEEDS_TREATMENT = 'Select a treatment: no treatment linked';
/** Chain record text of a new metric until its first value is recorded. */
export const METRIC_NEEDS_VALUE = 'Enter the first value';

type FieldKind = 'text' | 'date' | 'int' | 'number' | 'bool' | 'json';
type KindKey = keyof typeof KIND_KEY_SET;

interface FieldSpec {
  key: KindKey;
  column: string;
  type: FieldKind;
  /** Set by a command of its own (residual acceptance, metric values), never by a register patch. */
  readOnly?: string;
}

const KIND_KEY_SET = {
  issueType: 1, description: 1, lastReviewedAt: 1, requirements: 1, assetType: 1, classification: 1, riskProfileCode: 1, isOpportunity: 1,
  likelihood: 1, consequence: 1, impactDimensions: 1, residualLikelihood: 1, residualConsequence: 1, treatmentOption: 1, assessedAt: 1,
  nextReviewAt: 1, residualAcceptedAt: 1, unit: 1, targetValue: 1, frequencyCode: 1, lastMeasuredAt: 1,
} as const;
const KIND_KEYS = Object.keys(KIND_KEY_SET) as KindKey[];

/** The fields of each register kind (D.2 `RegisterItem`) and their columns. */
const FIELDS: Readonly<Record<RegisterKind, readonly FieldSpec[]>> = {
  'context-issues': [
    { key: 'issueType', column: 'issue_type', type: 'text' },
    { key: 'description', column: 'description', type: 'text' },
    { key: 'lastReviewedAt', column: 'last_reviewed_at', type: 'date' },
  ],
  'interested-parties': [
    { key: 'requirements', column: 'requirements', type: 'text' },
    { key: 'lastReviewedAt', column: 'last_reviewed_at', type: 'date' },
  ],
  'assets': [
    { key: 'assetType', column: 'asset_type', type: 'text' },
    { key: 'classification', column: 'classification', type: 'text' },
  ],
  'risks': [
    { key: 'riskProfileCode', column: 'risk_profile_code', type: 'text' },
    { key: 'isOpportunity', column: 'is_opportunity', type: 'bool' },
    { key: 'description', column: 'description', type: 'text' },
    { key: 'likelihood', column: 'likelihood', type: 'int' },
    { key: 'consequence', column: 'consequence', type: 'int' },
    { key: 'impactDimensions', column: 'impact_dimensions', type: 'json' },
    { key: 'residualLikelihood', column: 'residual_likelihood', type: 'int' },
    { key: 'residualConsequence', column: 'residual_consequence', type: 'int' },
    { key: 'treatmentOption', column: 'treatment_option', type: 'text' },
    { key: 'assessedAt', column: 'assessed_at', type: 'date' },
    { key: 'nextReviewAt', column: 'next_review_at', type: 'date' },
    { key: 'residualAcceptedAt', column: 'residual_accepted_at', type: 'date', readOnly: 'Residual acceptance sets it (POST .../residual-acceptance)' },
  ],
  'metrics': [
    { key: 'unit', column: 'unit', type: 'text' },
    { key: 'targetValue', column: 'target_value', type: 'number' },
    { key: 'frequencyCode', column: 'frequency_code', type: 'text' },
    { key: 'lastMeasuredAt', column: 'last_measured_at', type: 'date', readOnly: 'Recording a metric value sets it (POST .../values)' },
  ],
};

/** Fields the Risk Owner may change on own risks (F.6 `risk.manage` own: assessment fields). */
export const RISK_ASSESSMENT_KEYS: ReadonlySet<string> = new Set([
  'likelihood', 'consequence', 'impactDimensions', 'residualLikelihood', 'residualConsequence', 'treatmentOption', 'assessedAt', 'nextReviewAt',
]);

/** Kinds whose rows are chain records (C.10) with `pending_action`. */
const CHAIN_KINDS: ReadonlySet<RegisterKind> = new Set(['context-issues', 'risks', 'metrics']);

/** A stored register row as the commands read it (snake_case columns). */
type Row = Record<string, unknown> & { id: string; code: string; title: string; owner_user_id: string | null; updated_at: Date };

interface RiskProfile {
  likelihood: { min: number; max: number };
  consequence: { min: number; max: number };
  dimensions: string[] | null;
}

function scale(value: unknown, fallback: { min: number; max: number }): { min: number; max: number } {
  if (value && typeof value === 'object') {
    const v = value as { min?: unknown; max?: unknown };
    if (typeof v.min === 'number' && typeof v.max === 'number') return { min: v.min, max: v.max };
  }
  return fallback;
}

function same(a: unknown, b: unknown, type: FieldKind): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (type === 'number' || type === 'int') return Number(a) === Number(b);
  if (type === 'json') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function sqlValue(value: unknown, type: FieldKind): unknown {
  if (value === null || value === undefined) return null;
  if (type === 'json') return sql`${JSON.stringify(value)}::jsonb`;
  return value;
}

/** Wire value of a stored column. */
function wireValue(value: unknown, type: FieldKind): unknown {
  if (value === null || value === undefined) return null;
  if (type === 'number' || type === 'int') return Number(value);
  return value;
}

@Injectable()
export class RegistersService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly rules: RuleEngine,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
    @Inject(SCOPE_POLICY) private readonly scope: ScopePolicy,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/registers/{register}
  // -------------------------------------------------------------------------------------------------------------

  async list(principal: Principal, authz: AuthzState | null, ms: string, kind: RegisterKind, query: RegisterListQuery): Promise<Page<RegisterItem>> {
    const table = REGISTER_ENTITY_TYPES[kind];
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const readScope = await this.scope.readScope(trx, principal, ms, authz ?? { ms, granted: new Map(), ownOnly: false });
      const { rows } = await sql<Row & { owner_handle: string | null; owner_name: string | null; links: { slug: string; primary: boolean }[] }>`
        select t.*, o.handle as owner_handle, o.display_name as owner_name,
               (select json_agg(json_build_object('slug', m.slug, 'primary', l2.is_primary) order by l2.is_primary desc, m.slug)
                  from entity_ms_link l2 join management_system m on m.id = l2.management_system_id
                 where l2.entity_type = ${table} and l2.entity_id = t.id and l2.deleted_at is null) as links
          from ${sql.table(table)} t
          left join platform.app_user o on o.id = t.owner_user_id
         where t.deleted_at is null
           and exists (select 1 from entity_ms_link l where l.entity_type = ${table} and l.entity_id = t.id
                         and l.management_system_id = ${system.id} and l.deleted_at is null)
         order by t.position, t.code`.execute(trx);
      const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const items = rows
        .map((row) => ({ row, item: this.itemOf(kind, row, row.owner_handle, row.links ?? []), ownerUserId: row.owner_user_id }))
        .filter(({ row, item }) => {
          if (query.owner !== undefined && item.owner !== query.owner) return false;
          if (query.status !== undefined && item.status !== query.status) return false;
          if (words.length === 0) return true;
          const haystack = [row.code, row.title, row.owner_name, row.owner_handle].filter(Boolean).join(' ').toLowerCase();
          return words.every((w) => haystack.includes(w));
        });
      const visible = this.scope.filter(readScope, items);
      const start = (query.page - 1) * query.pageSize;
      return { items: visible.slice(start, start + query.pageSize).map((v) => v.item), page: query.page, pageSize: query.pageSize, total: visible.length };
    });
  }

  private itemOf(kind: RegisterKind, row: Row, ownerHandle: string | null, links: readonly { slug: string; primary: boolean }[]): RegisterItem {
    const table = REGISTER_ENTITY_TYPES[kind];
    const item: Record<string, unknown> = {
      ref: refOf('audit', table, row.id, row.code, new Date(row.updated_at)),
      code: row.code,
      title: row.title,
      owner: ownerHandle ?? 'none',
      updatedAt: new Date(row.updated_at).toISOString(),
      shared: links.length > 1,
      ms: links.map((l) => l.slug),
    };
    if (CHAIN_KINDS.has(kind)) item.status = row.pending_action ? 'open' : 'ready';
    for (const field of FIELDS[kind]) {
      const value = wireValue(row[field.column], field.type);
      if (field.key === 'riskProfileCode' || field.key === 'isOpportunity' || field.key === 'impactDimensions') {
        if (value !== null) item[field.key] = value;
      } else {
        item[field.key] = value;
      }
    }
    return item as RegisterItem;
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/registers/{register}
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, authz: AuthzState | null, ms: string, kind: RegisterKind, body: RegisterCreate): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    const table = REGISTER_ENTITY_TYPES[kind];
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const owner = body.ownerHandle !== undefined ? await this.members.resolveHandle(trx, body.ownerHandle) : kind === 'risks' ? null : actor;
      if (kind === 'risks') {
        if (!grantedInFull(authz, 'risk.manage')) throw new ForbiddenError('Creating a risk needs risk.manage');
      } else if (!grantedInFull(authz, 'register.manage') && owner !== actor) {
        throw new ForbiddenError('You can add rows only with yourself as the owner');
      }
      const systems = await this.linkedSystems(trx, system, body.linkedMs);
      const values = this.kindValues(kind, body, 'create');
      const edition = await editionOf(trx, system.id);
      if (kind === 'risks') {
        values.risk_profile_code ??= await this.defaultProfile(trx, edition);
        await this.rules.enforce<Br17Input>(trx, 'BR-17', { ownerUserId: owner }, { msIds: systems.map((s) => s.id) });
      }
      await this.validateKind(trx, kind, edition, values, {});
      if (systems.length > 1) await this.licence.assertFeature(org.id, 'integrated_mode', trx);
      await this.assertCodeFree(trx, table, body.code, null);

      const id = randomUUID();
      const position = await sql<{ next: number }>`select coalesce(max(position), -1)::int + 1 as next from ${sql.table(table)}`.execute(trx);
      const pending = kind === 'risks' ? RISK_NEEDS_TREATMENT : kind === 'metrics' ? METRIC_NEEDS_VALUE : null;
      const columns: Record<string, unknown> = {
        id,
        code: body.code,
        title: body.title,
        owner_user_id: owner,
        position: position.rows[0]?.next ?? 0,
        created_by: actor,
        updated_by: actor,
        ...(CHAIN_KINDS.has(kind) ? { pending_action: pending } : {}),
      };
      for (const field of FIELDS[kind]) {
        if (values[field.column] !== undefined) columns[field.column] = sqlValue(values[field.column], field.type);
      }
      const names = Object.keys(columns);
      let updatedAt: Date;
      try {
        const { rows } = await sql<{ updated_at: Date }>`
          insert into ${sql.table(table)} (${sql.join(names.map((n) => sql.ref(n)))})
          values (${sql.join(names.map((n) => columns[n] as RawBuilder<unknown>))})
          returning updated_at`.execute(trx);
        updatedAt = new Date(rows[0]!.updated_at);
      } catch (error) {
        duplicateCode(error, body.code);
      }
      for (const [index, s] of systems.entries()) {
        await trx
          .insertInto('entity_ms_link')
          .values({ entity_type: table as ShareableEntityType, entity_id: id, management_system_id: s.id, is_primary: index === 0, created_by: actor, updated_by: actor })
          .execute();
      }
      await this.audit.record(trx, {
        action: 'register.created',
        msId: system.id,
        entityType: table,
        entityId: id,
        entityCode: body.code,
        after: {
          // `code` alone is a secret key name of F.11 redaction; the business code goes under `register_code`.
          register_code: body.code,
          title: body.title,
          owner: body.ownerHandle ?? (owner === actor ? principal.user.handle : 'none'),
          linked_ms: systems.map((s) => s.slug),
          ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)),
          ...(pending ? { pending_action: pending } : {}),
        },
      });
      return commandResult(systems.map((s) => s.slug), { ref: refOf('audit', table, id, body.code, updatedAt!) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/registers/{register}/{id}
  // -------------------------------------------------------------------------------------------------------------

  async update(
    principal: Principal,
    authz: AuthzState | null,
    ms: string,
    kind: RegisterKind,
    id: string,
    patch: RegisterPatch,
    ifMatch: string | undefined,
  ): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    const table = REGISTER_ENTITY_TYPES[kind];
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, table, id, { forUpdate: true });
      const row = record.row as Row;
      assertIfMatch(ifMatch, row.updated_at, refOf('audit', table, row.id, row.code, row.updated_at));
      const given = Object.entries(patch).filter(([k, v]) => k !== 'confirm' && v !== undefined).map(([k]) => k);

      // F.6: risks need risk.manage (the Risk Owner only for the assessment fields of own risks); the other kinds
      // register.manage, own-scoped roles only on own rows and without handing them to someone else.
      const permission = kind === 'risks' ? 'risk.manage' : 'register.manage';
      if (!grantedInFull(authz, permission)) {
        if (row.owner_user_id !== actor) throw new ForbiddenError('Only the owner of this record can change it');
        if (kind === 'risks' && given.some((k) => !RISK_ASSESSMENT_KEYS.has(k))) {
          throw new ForbiddenError('A Risk Owner changes only the assessment fields of own risks');
        }
      }

      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: string, value: unknown, type: FieldKind, shown: unknown = value) => {
        if (same(row[column], value, type)) return;
        set[column] = sqlValue(value, type);
        before[column] = wireValue(row[column], type);
        after[column] = shown ?? null;
      };

      if (patch.code !== undefined && patch.code !== row.code) {
        await this.assertCodeFree(trx, table, patch.code, row.id);
        change('code', patch.code, 'text');
      }
      if (patch.title !== undefined) change('title', patch.title, 'text');
      let owner = row.owner_user_id;
      if (patch.ownerHandle !== undefined) {
        owner = await this.members.resolveHandle(trx, patch.ownerHandle);
        if (!grantedInFull(authz, permission) && owner !== actor) throw new ForbiddenError('You cannot hand your record to someone else');
        change('owner_user_id', owner, 'text', patch.ownerHandle);
      }

      const values = this.kindValues(kind, patch, 'patch');
      const links = await linksOf(trx, table, row.id);
      const edition = await editionOf(trx, record.ms.id);
      await this.validateKind(trx, kind, edition, values, row);
      for (const field of FIELDS[kind]) {
        if (values[field.column] !== undefined) change(field.column, values[field.column], field.type);
      }

      let target: MsRef[] | null = null;
      if (patch.linkedMs !== undefined) {
        target = await this.linkedSystems(trx, record.ms, patch.linkedMs);
        const current = new Set(links.map((l) => l.msId));
        if (target.length > 1 && target.some((s) => !current.has(s.id))) await this.licence.assertFeature(org.id, 'integrated_mode', trx);
      }
      const affected: Pick<LinkRow, 'msId' | 'slug'>[] = [...links, ...(target ?? []).map((s) => ({ msId: s.id, slug: s.slug }))];
      if (kind === 'risks' && patch.ownerHandle !== undefined) {
        await this.rules.enforce<Br17Input>(trx, 'BR-17', { ownerUserId: owner }, { msIds: affected.map((l) => l.msId), ref: refOf('audit', table, row.id, row.code, row.updated_at) });
      }
      // BR-22: a row shared by several systems changes everywhere; the caller confirms first.
      await confirmShared(trx, this.rules, affected, record.ms.slug, patch.confirm);

      if (target) {
        const changedLinks = await this.replaceLinks(trx, table, row.id, links, target, actor);
        if (changedLinks) {
          before.linked_ms = links.map((l) => l.slug);
          after.linked_ms = target.map((s) => s.slug);
        }
      }
      const code = (patch.code ?? row.code) as string;
      if ('code' in after) {
        before.register_code = before.code;
        after.register_code = after.code;
        delete before.code;
        delete after.code;
      }
      const changed = Object.keys(after).length > 0;
      const updatedAt = changed ? await bump(trx, table, row.id, { ...set, updated_by: actor }) : new Date(row.updated_at);
      if (changed) {
        await this.audit.record(trx, { action: 'register.updated', msId: record.ms.id, entityType: table, entityId: row.id, entityCode: code, before, after });
      }
      const systems = new Set([...links.map((l) => l.slug), ...(target ?? []).map((s) => s.slug)]);
      return commandResult([...systems], {
        ref: refOf('audit', table, row.id, code, updatedAt),
        ...(changed ? {} : { message: ['Nothing to change', 'Tidak ada yang diubah'] }),
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/metrics/{id}/values
  // -------------------------------------------------------------------------------------------------------------

  async recordMetricValue(principal: Principal, authz: AuthzState | null, ms: string, id: string, body: MetricValueRequest): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, 'metric', id, { forUpdate: true });
      const row = record.row as Row & { last_measured_at: string | null; pending_action: string | null };
      if (!grantedInFull(authz, 'metric.record') && row.owner_user_id !== actor) throw new ForbiddenError('Only the owner of this metric can record values');
      const { rows: overlaps } = await sql<{ period_start: string; period_end: string }>`
        select period_start, period_end from metric_value
         where metric_id = ${row.id} and deleted_at is null and period_start <= ${body.periodEnd}::date and period_end >= ${body.periodStart}::date
         limit 1`.execute(trx);
      if (overlaps[0]) {
        const { period_start: from, period_end: to } = overlaps[0];
        throw unprocessable(
          'metric.period_overlap',
          `The period overlaps the value recorded for ${fmtDay(from, 'en')} - ${fmtDay(to, 'en')}`,
          `Periode tumpang tindih dengan nilai yang tercatat untuk ${fmtDay(from, 'id')} - ${fmtDay(to, 'id')}`,
        );
      }
      const valueId = randomUUID();
      await trx
        .insertInto('metric_value')
        .values({
          id: valueId, metric_id: row.id, period_start: body.periodStart, period_end: body.periodEnd, value: String(body.value),
          note: body.note ?? null, created_by: actor, updated_by: actor,
        })
        .execute();
      const lastMeasured = row.last_measured_at && row.last_measured_at > body.periodEnd ? row.last_measured_at : body.periodEnd;
      // The open chain action of a metric is entering its values; recording one completes it (C.10, UI 1.8).
      const set: Record<string, unknown> = { last_measured_at: lastMeasured, updated_by: actor };
      if (row.pending_action) Object.assign(set, { pending_action: null, action_completed_at: sql`now()`, action_completed_by: actor });
      const updatedAt = await bump(trx, 'metric', row.id, set);
      await this.audit.record(trx, {
        action: 'metric.value_recorded',
        msId: record.ms.id,
        entityType: 'metric',
        entityId: row.id,
        entityCode: row.code,
        before: { last_measured_at: row.last_measured_at, ...(row.pending_action ? { pending_action: row.pending_action } : {}) },
        after: {
          last_measured_at: lastMeasured, period_start: body.periodStart, period_end: body.periodEnd, value: body.value,
          ...(body.note ? { note: body.note } : {}), ...(row.pending_action ? { pending_action: null } : {}),
        },
      });
      const links = await linksOf(trx, 'metric', row.id);
      return commandResult(links.map((l) => l.slug), { ref: refOf('audit', 'metric', row.id, row.code, updatedAt), data: { valueId } });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** The kind's columns from a create or patch body; fields of other kinds and read-only fields are 400. */
  private kindValues(kind: RegisterKind, body: Partial<Record<KindKey, unknown>>, mode: 'create' | 'patch'): Record<string, unknown> {
    const specs = new Map(FIELDS[kind].map((f) => [f.key, f]));
    const errors: { path: string; message: string }[] = [];
    const values: Record<string, unknown> = {};
    for (const key of KIND_KEYS) {
      const value = body[key];
      if (value === undefined) continue;
      const spec = specs.get(key);
      if (!spec) errors.push({ path: `body.${key}`, message: `Not a field of the ${kind} register` });
      else if (spec.readOnly) errors.push({ path: `body.${key}`, message: spec.readOnly });
      else if (mode === 'patch' && key === 'riskProfileCode' && value === null) errors.push({ path: `body.${key}`, message: 'A risk keeps a profile' });
      else values[spec.column] = value;
    }
    if (errors.length > 0) throw new ValidationError(errors, 'The request has fields this register does not have');
    return values;
  }

  /** Lookups and scales of the edition (risk profile scales and dimensions, treatment options, asset types, frequencies). */
  private async validateKind(trx: Trx, kind: RegisterKind, edition: string, values: Record<string, unknown>, current: Record<string, unknown>): Promise<void> {
    if (kind === 'risks') {
      const profileCode = (values.risk_profile_code ?? current.risk_profile_code) as string;
      const touchesProfile = ['risk_profile_code', 'likelihood', 'consequence', 'residual_likelihood', 'residual_consequence', 'impact_dimensions']
        .some((c) => values[c] !== undefined);
      if (touchesProfile) {
        const profile = await this.profileOf(trx, edition, profileCode);
        const check = (column: string, label: string, range: { min: number; max: number }) => {
          const value = values[column] !== undefined ? values[column] : current[column];
          if (value === null || value === undefined) return;
          const n = Number(value);
          if (n < range.min || n > range.max) {
            throw unprocessable('risk.scale', `${label} must be between ${range.min} and ${range.max} in profile ${profileCode}`,
              `${label} harus antara ${range.min} dan ${range.max} pada profil ${profileCode}`);
          }
        };
        check('likelihood', 'Likelihood', profile.likelihood);
        check('consequence', 'Consequence', profile.consequence);
        check('residual_likelihood', 'Residual likelihood', profile.likelihood);
        check('residual_consequence', 'Residual consequence', profile.consequence);
        const dimensions = (values.impact_dimensions ?? current.impact_dimensions ?? {}) as Record<string, number>;
        for (const [name, value] of Object.entries(dimensions)) {
          if (profile.dimensions && !profile.dimensions.includes(name)) {
            throw unprocessable('risk.dimension', `Impact dimension ${name} is not part of profile ${profileCode}`,
              `Dimensi dampak ${name} bukan bagian dari profil ${profileCode}`);
          }
          if (value > profile.consequence.max) {
            throw unprocessable('risk.scale', `Impact ${name} must be at most ${profile.consequence.max}`, `Dampak ${name} paling tinggi ${profile.consequence.max}`);
          }
        }
      }
      if (typeof values.treatment_option === 'string') await this.assertLookup(trx, edition, 'treatment_option', values.treatment_option, true);
    }
    if (kind === 'assets' && typeof values.asset_type === 'string') await this.assertLookup(trx, edition, 'asset_type', values.asset_type, false);
    if (kind === 'metrics' && typeof values.frequency_code === 'string') await assertFrequency(trx, edition, values.frequency_code);
  }

  /**
   * 422 unless the code is a `ref.lookup_value` of the domain in the edition. A domain the pack does not define
   * accepts any value when `strict` is false (asset types are free text until a pack lists them).
   */
  private async assertLookup(trx: Trx, edition: string, domain: string, code: string, strict: boolean): Promise<void> {
    const { rows } = await sql<{ code: string }>`
      select code from ref.lookup_value where framework_version_id = ${edition} and domain = ${domain}`.execute(trx);
    if (!strict && rows.length === 0) return;
    if (!rows.some((r) => r.code === code)) {
      throw unprocessable('register.unknown_lookup', `${code} is not a value of ${domain} in the edition in use`,
        `${code} bukan nilai ${domain} pada edisi yang digunakan`);
    }
  }

  private async profileOf(trx: Trx, edition: string, code: string): Promise<RiskProfile> {
    const { rows } = await sql<{ definition: Record<string, unknown> }>`
      select definition from ref.risk_profile where framework_version_id = ${edition} and code = ${code}`.execute(trx);
    const definition = rows[0]?.definition;
    if (!definition) {
      throw unprocessable('risk.unknown_profile', `Risk profile ${code} is not defined by the edition in use`,
        `Profil risiko ${code} tidak didefinisikan oleh edisi yang digunakan`);
    }
    const dims = definition.impact_dimensions;
    return {
      likelihood: scale(definition.likelihood_scale, { min: 1, max: 5 }),
      consequence: scale(definition.consequence_scale, { min: 1, max: 5 }),
      dimensions: Array.isArray(dims) ? dims.filter((d): d is string => typeof d === 'string') : null,
    };
  }

  /** The edition's only risk profile; 422 when it has none or several (the request must name one). */
  private async defaultProfile(trx: Trx, edition: string): Promise<string> {
    const { rows } = await sql<{ code: string }>`
      select code from ref.risk_profile where framework_version_id = ${edition} order by code`.execute(trx);
    if (rows.length !== 1) {
      throw unprocessable('risk.profile_required', 'Name the risk profile of this risk (riskProfileCode)', 'Sebutkan profil risiko untuk risiko ini (riskProfileCode)');
    }
    return rows[0]!.code;
  }

  /** The systems of `linkedMs` (default: the path system); the path system must be one of them. */
  private async linkedSystems(trx: Trx, system: MsRef, linkedMs: readonly string[] | undefined): Promise<MsRef[]> {
    const slugs = linkedMs ?? [system.slug];
    if (new Set(slugs).size !== slugs.length) throw new ValidationError([{ path: 'body.linkedMs', message: 'A system is listed twice' }]);
    if (!slugs.includes(system.slug)) {
      throw unprocessable('register.path_system_missing', `linkedMs must include ${system.slug}, the system of the request`,
        `linkedMs harus mencakup ${system.slug}, sistem dari permintaan ini`);
    }
    const out: MsRef[] = [];
    for (const slug of slugs) out.push(slug === system.slug ? system : await this.records.resolveMs(trx, slug));
    return out;
  }

  /** 409 when a live row of the table already has the code. */
  private async assertCodeFree(trx: Trx, table: string, code: string, exceptId: string | null): Promise<void> {
    const { rows } = await sql<{ id: string }>`
      select id from ${sql.table(table)} where code = ${code} and deleted_at is null ${exceptId ? sql`and id <> ${exceptId}` : sql``} limit 1`.execute(trx);
    if (rows.length > 0) throw new ConflictError(`${code} already exists`, { messageKey: 'register.duplicate_code' });
  }

  /**
   * Makes the live links equal `target` (first primary, A-29): links of systems no longer listed are soft deleted,
   * new ones inserted, the primary flag moved. The deferred trigger checks one primary at commit.
   */
  private async replaceLinks(trx: Trx, table: string, entityId: string, links: readonly LinkRow[], target: readonly MsRef[], actor: string): Promise<boolean> {
    const wanted = new Set(target.map((s) => s.id));
    const primary = target[0]!.id;
    let changed = false;
    // Clear the primary flag first, so the partial unique index never sees two primaries.
    for (const link of links) {
      if (link.isPrimary && link.msId !== primary) {
        await trx.updateTable('entity_ms_link').set({ is_primary: false, updated_at: sql`now()`, updated_by: actor }).where('id', '=', link.id).execute();
        changed = true;
      }
    }
    for (const link of links) {
      if (!wanted.has(link.msId)) {
        await trx.updateTable('entity_ms_link').set({ deleted_at: sql`now()`, updated_at: sql`now()`, updated_by: actor }).where('id', '=', link.id).execute();
        changed = true;
      }
    }
    for (const s of target) {
      const existing = links.find((l) => l.msId === s.id);
      if (!existing) {
        await trx
          .insertInto('entity_ms_link')
          .values({ entity_type: table as ShareableEntityType, entity_id: entityId, management_system_id: s.id, is_primary: s.id === primary, created_by: actor, updated_by: actor })
          .execute();
        changed = true;
      } else if (s.id === primary && !existing.isPrimary) {
        await trx.updateTable('entity_ms_link').set({ is_primary: true, updated_at: sql`now()`, updated_by: actor }).where('id', '=', existing.id).execute();
        changed = true;
      }
    }
    return changed;
  }
}
