// Shared steps of the risk-side register commands (build plan D.1, D.3 "Registers and workflows: risk side", C.13,
// F.7): the organisation and its date, the C.13 row a caller performs, record refs with their new ETag, command
// results, problems of the 422 kind, live system links of shareable records (A-29), the `updated_at` bump that
// changes the ETag, and the `freshness.recompute` job sent in the command's transaction (E.2).
import {
  rejectionFor, transitionsVia, type CommandResult, type MachineEntity, type Pair, type RecordModule, type RecordRef, type Transition,
  type Warning,
} from '@mscd/shared';
import { sql } from 'kysely';
import type { Clock } from '../../common/clock';
import { etagOf } from '../../common/etag';
import type { JobQueue } from '../../common/jobs/job-queue';
import { BusinessRuleError, ForbiddenError, NotFoundError, ProblemError, TransitionNotAllowedError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
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

/** A record ref with the ETag of the given version (D.1 Concurrency, A-21). */
export function refOf(module: RecordModule, entityType: string, id: string, code: string, updatedAt: Date): RecordRef {
  return { module, entityType, id, code, etag: etagOf(updatedAt) };
}

/** A `CommandResult` (D.2); empty optional members are left out. */
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

/** 422 `business-rule` without a rule id (lookups, targets, periods): the message in both languages. */
export function unprocessable(messageKey: string, en: string, id: string): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages: { en, id }, detail: en });
}

/**
 * The C.13 row the caller performs for `(from, to)` on the machine's own route (`via` null):
 * - no row: 422 with the rule of a rejection of the same route (for example BR-04 for closing a treatment without
 *   residual acceptance), else 409 `transition-not-allowed`;
 * - rows only the system performs (`permission: null`): 409;
 * - the first row whose permission the guard granted in full, or granted own-scoped on a row marked `own` when the
 *   caller owns the record; an own-scoped caller on someone else's record gets 403, as does a caller without any of
 *   the rows' permissions.
 */
export function pickTransition(entity: MachineEntity, from: string | null, to: string, authz: AuthzState | null, ownsRecord: boolean): Transition {
  const rows = transitionsVia(entity, from, to, null);
  if (rows.length === 0) {
    const rejection = rejectionFor(entity, from, to, null);
    if (rejection) throw new BusinessRuleError(rejection.rule, ruleMessages(rejection.rule), undefined, { messageKey: ruleMessageKey(rejection.rule) });
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

/** True when the guard granted the permission in full (not only through an own-scoped role). */
export function grantedInFull(authz: AuthzState | null, permission: string): boolean {
  return authz?.granted.get(permission as never) === 'full';
}

/**
 * Writes a new `updated_at` (`greatest(clock_timestamp(), updated_at + 1 ms)`) together with `set`, so every
 * successful command changes the record's ETag; returns the new value.
 */
export async function bump(trx: Trx, table: string, id: string, set: Record<string, unknown> = {}): Promise<Date> {
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
  id: string;
  msId: string;
  slug: string;
  /** `management_system.code` (for example ISMS), as rule messages name systems. */
  code: string;
  isPrimary: boolean;
}

/** The live links of a shareable record, primary first, then by system slug. */
export async function linksOf(trx: Trx, entityType: string, entityId: string): Promise<LinkRow[]> {
  const { rows } = await sql<{ id: string; ms_id: string; slug: string; code: string; is_primary: boolean }>`
    select l.id, l.management_system_id as ms_id, m.slug, m.code, l.is_primary
      from entity_ms_link l join management_system m on m.id = l.management_system_id
     where l.entity_type = ${entityType} and l.entity_id = ${entityId} and l.deleted_at is null
     order by l.is_primary desc, m.slug`.execute(trx);
  return rows.map((r) => ({ id: r.id, msId: r.ms_id, slug: r.slug, code: r.code, isPrimary: r.is_primary }));
}

/** The framework edition (`framework_version_id`) a system uses. */
export async function editionOf(trx: Trx, msId: string): Promise<string> {
  const row = await trx.selectFrom('management_system').select('framework_version_id').where('id', '=', msId).executeTakeFirstOrThrow();
  return row.framework_version_id;
}

/** 422 unless the frequency is one of the edition's `ref.evidence_frequency_rule` codes. */
export async function assertFrequency(trx: Trx, editionId: string, frequencyCode: string): Promise<void> {
  const { rows } = await sql<{ code: string }>`
    select code from ref.evidence_frequency_rule where framework_version_id = ${editionId} and code = ${frequencyCode}`.execute(trx);
  if (rows.length === 0) {
    throw unprocessable(
      'register.unknown_frequency',
      `Frequency ${frequencyCode} is not defined by the edition in use`,
      `Frekuensi ${frequencyCode} tidak didefinisikan oleh edisi yang digunakan`,
    );
  }
}

/** A catalogue item or requirement of an edition by its code; 422 when the edition has none. */
export async function targetOf(trx: Trx, editionId: string, targetType: 'catalogue_item' | 'requirement', code: string): Promise<string> {
  const { rows } = targetType === 'catalogue_item'
    ? await sql<{ id: string }>`select id from ref.catalogue_item where framework_version_id = ${editionId} and item_code = ${code}`.execute(trx)
    : await sql<{ id: string }>`select id from ref.requirement where framework_version_id = ${editionId} and requirement_code = ${code}`.execute(trx);
  const id = rows[0]?.id;
  if (!id) {
    const kind = targetType === 'catalogue_item' ? ['catalogue item', 'butir katalog'] : ['requirement', 'persyaratan'];
    throw unprocessable('register.unknown_target', `${code} is not a ${kind[0]} of the edition in use`, `${code} bukan ${kind[1]} dari edisi yang digunakan`);
  }
  return id;
}

/**
 * Queues `freshness.recompute` for a system in the command's transaction (E.2: 5 second debounce, singleton per
 * organisation and system, `fr:<org>:<ms>`), so the job commits or rolls back with the change it follows.
 */
export async function enqueueFreshness(
  queue: JobQueue,
  trx: Trx,
  org: Pick<TenantInfo, 'id'>,
  msId: string,
  scope: { entryIds?: string[]; evidenceIds?: string[] },
  requestedBy: string,
): Promise<void> {
  await queue.send(
    'freshness.recompute',
    {
      orgId: org.id,
      requestId: currentRequestId(),
      requestedBy,
      payload: { msId, ...(scope.entryIds?.length ? { entryIds: scope.entryIds } : {}), ...(scope.evidenceIds?.length ? { evidenceIds: scope.evidenceIds } : {}) },
    },
    { singletonKey: `fr:${org.id}:${msId}`, startAfterSeconds: 5, retryLimit: 3 },
    trx,
  );
}

/** Maps a unique violation of the code index to 409 `conflict`; rethrows anything else. */
export function duplicateCode(error: unknown, code: string): never {
  if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
    throw new ProblemError('conflict', { detail: `${code} already exists`, messageKey: 'register.duplicate_code' });
  }
  throw error;
}
