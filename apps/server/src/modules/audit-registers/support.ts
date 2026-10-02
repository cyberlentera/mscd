// Shared steps of the audit-side register commands (build plan D.1, D.3 "Registers and workflows: audit side",
// C.13, F.7, WP-37): the organisation and its date, record refs with their new ETag, command results, the C.13 row
// a caller performs, problems of the 422 kind, the `updated_at` bump that changes the ETag, live system links of
// shareable records (management reviews and audit events), the framework edition of a system and its current
// certification cycle.
import {
  rejectionFor, transitionsVia, type CommandResult, type MachineEntity, type Pair, type RecordRef, type Transition, type Warning,
} from '@mscd/shared';
import { sql } from 'kysely';
import type { Clock } from '../../common/clock';
import { etagOf } from '../../common/etag';
import {
  BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ProblemError, TransitionNotAllowedError, ValidationError,
} from '../../common/problems';
import type { AuthzState, Principal, TenantInfo, Trx } from '../../common/tokens';
import { ruleMessageKey, ruleMessages } from '../rules';

/** The organisation of the caller's session (every route of this module is ms-scoped, so there is one). */
export function orgOf(principal: Principal): TenantInfo {
  if (!principal.org) throw new NotFoundError('No organisation is selected');
  return principal.org;
}

/** Today in the organisation (D-07: `demo.fixed_today` in demo and test installs). */
export function todayOf(clock: Clock, org: Pick<TenantInfo, 'timeZone'>): string {
  return clock.todayIn(org.timeZone);
}

/** A record ref of the audit module with the ETag of the given version (D.1 Concurrency, A-21). */
export function refOf(entityType: string, id: string, code: string, updatedAt: Date | string): RecordRef {
  return { module: 'audit', entityType, id, code, etag: etagOf(new Date(updatedAt)) };
}

/** A `CommandResult` (D.2); empty optional members are left out, `changed` is sorted and unique. */
export function commandResult(
  changed: readonly string[],
  extra: { ref?: RecordRef; warnings?: readonly Warning[]; message?: Pair; data?: unknown; count?: number } = {},
): CommandResult {
  return {
    ok: true,
    changed: [...new Set(changed)].sort(),
    ...(extra.count !== undefined ? { count: extra.count } : {}),
    ...(extra.message ? { message: extra.message } : {}),
    ...(extra.warnings && extra.warnings.length > 0 ? { warnings: [...extra.warnings] } : {}),
    ...(extra.ref ? { ref: extra.ref } : {}),
    ...(extra.data !== undefined ? { data: extra.data } : {}),
  };
}

/** 422 `business-rule` without a rule id (unknown lookups, missing systems): the message in both languages. */
export function unprocessable(messageKey: string, en: string, id: string): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages: { en, id }, detail: en });
}

/** 422 for a rule the command checks itself (a database backstop answered as the rule it enforces). */
export function ruleError(rule: Parameters<typeof ruleMessages>[0], ref?: RecordRef): BusinessRuleError {
  return new BusinessRuleError(rule, ruleMessages(rule), ref, { messageKey: ruleMessageKey(rule) });
}

/**
 * The C.13 row the caller performs for `(from, to)` on the machine's own route (`via` null), as WP-20 and WP-35 do
 * it: no row gives 422 with the rule of a rejection, else 409 `transition-not-allowed`; rows only the system
 * performs give 409; the first row granted in full wins; an own-scoped grant works on a row marked `own` when the
 * caller holds the record, else 403.
 */
export function pickTransition(entity: MachineEntity, from: string | null, to: string, authz: AuthzState | null, ownsRecord: boolean): Transition {
  const rows = transitionsVia(entity, from, to, null);
  if (rows.length === 0) {
    const rejection = rejectionFor(entity, from, to, null);
    if (rejection) throw ruleError(rejection.rule);
    throw new TransitionNotAllowedError(from, to);
  }
  const userRows = rows.filter((r) => r.permission !== null);
  if (userRows.length === 0) throw new TransitionNotAllowedError(from, to);
  const granted = authz?.granted ?? new Map();
  const full = userRows.find((r) => granted.get(r.permission!) === 'full');
  if (full) return full;
  const own = userRows.find((r) => r.own && granted.get(r.permission!) === 'own');
  if (own && ownsRecord) return own;
  if (own) throw new ForbiddenError('Only the owner of this record can make this change');
  throw new ForbiddenError(`This change needs ${[...new Set(userRows.map((r) => r.permission))].join(' or ')}`);
}

/**
 * 400 `validation` for request members a C.13 row requires (`requires`): strings must be non-empty, booleans
 * present.
 */
export function assertRequires(row: Transition, body: Readonly<Record<string, unknown>>): void {
  const missing = (row.requires ?? []).filter((name) => {
    const value = body[name];
    if (typeof value === 'boolean') return false;
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing.length > 0) {
    throw new ValidationError(
      missing.map((name) => ({ path: `body.${name}`, message: `Required for ${row.from ?? 'a new record'} to ${row.to}` })),
      'The transition needs more information',
    );
  }
}

/**
 * Sets columns of one row and a new `updated_at` (`greatest(clock_timestamp(), updated_at + 1 ms)`, so every
 * successful command changes the ETag); returns the new value. `table` is one of this module's tables, never
 * request input.
 */
export async function bump(trx: Trx, table: string, id: string, set: Record<string, unknown>): Promise<Date> {
  const assignments = Object.entries(set).map(([column, value]) => sql`${sql.ref(column)} = ${value}`);
  const { rows } = await sql<{ updated_at: Date }>`
    update ${sql.table(table)}
       set ${sql.join([...assignments, sql`updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')`])}
     where id = ${id}
    returning updated_at`.execute(trx);
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return new Date(row.updated_at);
}

/** One live `entity_ms_link` of a shareable record. */
export interface LinkRow {
  msId: string;
  slug: string;
  code: string;
  editionId: string;
  isPrimary: boolean;
}

/** The live links of a shareable record, primary first, then by system slug. */
export async function linksOf(trx: Trx, entityType: string, entityId: string): Promise<LinkRow[]> {
  const { rows } = await sql<{ ms_id: string; slug: string; code: string; edition_id: string; is_primary: boolean }>`
    select l.management_system_id as ms_id, m.slug, m.code, m.framework_version_id as edition_id, l.is_primary
      from entity_ms_link l join management_system m on m.id = l.management_system_id and m.deleted_at is null
     where l.entity_type = ${entityType} and l.entity_id = ${entityId} and l.deleted_at is null
     order by l.is_primary desc, m.slug`.execute(trx);
  return rows.map((r) => ({ msId: r.ms_id, slug: r.slug, code: r.code, editionId: r.edition_id, isPrimary: r.is_primary }));
}

/** The framework edition (`framework_version_id`) a system uses. */
export async function editionOf(trx: Trx, msId: string): Promise<string> {
  const row = await trx.selectFrom('management_system').select('framework_version_id').where('id', '=', msId).executeTakeFirstOrThrow();
  return row.framework_version_id;
}

/** The next free `position` of a table within a system (new rows go last). */
export async function nextPosition(trx: Trx, table: 'finding' | 'audit_activity', msId: string): Promise<number> {
  const { rows } = await sql<{ next: number }>`
    select coalesce(max(position), -1)::int + 1 as next from ${sql.table(table)} where management_system_id = ${msId}`.execute(trx);
  return rows[0]?.next ?? 0;
}

/** Maps a unique violation (a live code) to 409 `conflict`; rethrows anything else. */
export function duplicateCode(error: unknown, code: string): never {
  if (isPgError(error, '23505')) throw new ConflictError(`${code} already exists`, { messageKey: 'register.duplicate_code' });
  throw error;
}

/** True for a PostgreSQL error with the SQLSTATE `code` (for example 23514 check violation). */
export function isPgError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
}

/** Name of the constraint a PostgreSQL error names, when it names one. */
export function constraintOf(error: unknown): string | null {
  const e = error as { constraint?: unknown } | null;
  return e && typeof e.constraint === 'string' ? e.constraint : null;
}

/** Text that holds something other than white space. */
export function filled(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim() !== '';
}

/** An audit event row as this module reads it. */
export interface AuditEventRow {
  id: string;
  management_system_id: string;
  event_type: string;
  short_label: string;
  scheduled_at: string;
}

/**
 * An audit event of the path system: its own (`management_system_id`) or shared with it through `entity_ms_link`
 * (a joint audit); 404 otherwise (F.7). Seeded events carry no link row, so both paths are checked, as WP-35 does.
 */
export async function auditEventOf(trx: Trx, system: { id: string }, id: string, forUpdate = false): Promise<AuditEventRow> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(id)) throw new NotFoundError('Unknown audit event');
  const { rows } = await sql<AuditEventRow>`
    select e.id, e.management_system_id, e.event_type, e.short_label, e.scheduled_at from audit_event e
     where e.id = ${id} and e.deleted_at is null
       and (e.management_system_id = ${system.id}
            or exists (select 1 from entity_ms_link l where l.entity_type = 'audit_event' and l.entity_id = e.id
                         and l.management_system_id = ${system.id} and l.deleted_at is null))
     ${forUpdate ? sql`for update of e` : sql``}`.execute(trx);
  const row = rows[0];
  if (!row) throw new NotFoundError('Unknown audit event');
  return row;
}
