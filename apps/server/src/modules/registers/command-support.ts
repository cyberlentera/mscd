// Shared steps of the register, document, audit event and reminder commands (build plan D.1, D.3, F.7, WP-35):
// the caller's organisation and date, record refs with their new ETag, the `CommandResult`, the own-scope check of
// own-only grants, the next audit date of a system (BR-41), row writes that move `updated_at` forward (so every
// successful command changes the ETag), and `freshness.recompute` queued in the command's transaction (E.2).
import {
  rejectionFor, transitionsVia, type CommandResult, type MachineEntity, type Pair, type Permission, type RecordModule, type RecordRef,
  type Transition, type Warning,
} from '@mscd/shared';
import { sql } from 'kysely';
import type { Clock } from '../../common/clock';
import { etagOf } from '../../common/etag';
import type { JobQueue } from '../../common/jobs/job-queue';
import {
  BusinessRuleError, ForbiddenError, NotFoundError, ProblemError, TransitionNotAllowedError, ValidationError,
} from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import type { AuthzState, Principal, TenantInfo, Trx } from '../../common/tokens';
import { ruleMessageKey, ruleMessages } from '../rules';

/** Module of a record ref by table (ARCHITECTURE 13, as the read model's `REF_MODULE` names them). */
const MODULE_OF: Readonly<Record<string, RecordModule>> = {
  applicability_entry: 'implementation',
  implementation_activity_progress: 'implementation',
  document: 'implementation',
  evidence: 'surveillance',
  cycle_requirement_status: 'surveillance',
  drift_result: 'surveillance',
};

/** The organisation of the caller's session (every WP-35 route runs in one). */
export function orgOf(principal: Principal): TenantInfo {
  if (!principal.org) throw new NotFoundError('No organisation is selected');
  return principal.org;
}

/** Today in the organisation (D-07: `demo.fixed_today` in demo and test installs). */
export function todayOf(clock: Clock, org: Pick<TenantInfo, 'timeZone'>): string {
  return clock.todayIn(org.timeZone);
}

/** A record ref with the ETag of its version (D.1 Concurrency, A-21). */
export function refOf(entityType: string, id: string, code: string, updatedAt: Date | string): RecordRef {
  return { module: MODULE_OF[entityType] ?? 'audit', entityType, id, code, etag: etagOf(new Date(updatedAt)) };
}

/** A `CommandResult` (D.2); empty optional members are left out. */
export function commandResult(
  changed: readonly string[],
  extra: { ref?: RecordRef; warnings?: readonly Warning[]; message?: Pair; data?: unknown; count?: number } = {},
): CommandResult {
  return {
    ok: true,
    changed: [...new Set(changed)],
    ...(extra.count !== undefined ? { count: extra.count } : {}),
    ...(extra.message ? { message: extra.message } : {}),
    ...(extra.warnings && extra.warnings.length > 0 ? { warnings: [...extra.warnings] } : {}),
    ...(extra.ref ? { ref: extra.ref } : {}),
    ...(extra.data !== undefined ? { data: extra.data } : {}),
  };
}

/**
 * F.7 own grants: when the guard admitted the caller for `permission` only through an own-scoped role, the record
 * must be held by the caller (owner or holder); otherwise 403.
 */
export function assertOwnScope(authz: AuthzState | null, permission: Permission, holders: readonly (string | null | undefined)[], userId: string): void {
  const grant = authz?.granted.get(permission);
  if (grant === 'full') return;
  if (grant === 'own') {
    if (holders.some((h) => h === userId)) return;
    throw new ForbiddenError('Only the holder of this record can make this change');
  }
  throw new ForbiddenError(`This change needs ${permission}`);
}

/** 422 `business-rule` with a message key and texts but no rule id (unknown lookups, missing systems). */
export function unprocessable(messageKey: string, en: string, id: string): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages: { en, id }, detail: en });
}

/**
 * Sets columns of one row and a new `updated_at` (`greatest(clock_timestamp(), updated_at + 1 ms)`, so the ETag
 * always changes); returns the new `updated_at`. `table` is one of the tables the WP-35 commands write, never
 * request input.
 */
export async function writeRow(trx: Trx, table: string, id: string, set: Record<string, unknown>, actor: string): Promise<Date> {
  const assignments = Object.entries({ ...set, updated_by: actor }).map(([column, value]) => sql`${sql.ref(column)} = ${value}`);
  const { rows } = await sql<{ updated_at: Date }>`
    update ${sql.table(table)} set ${sql.join(assignments)}, updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
     where id = ${id} returning updated_at`.execute(trx);
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return new Date(row.updated_at);
}

/**
 * Date of the system's next audit event (`MS.audit.date`, the basis of the After audit flag of BR-41): the earliest
 * event on or after today, as the read model's `nextAuditEvent` picks it.
 */
export async function nextAuditDate(trx: Trx, msId: string, today: string): Promise<{ id: string; date: string } | null> {
  const { rows } = await sql<{ id: string; scheduled_at: string }>`
    select id, scheduled_at from audit_event
     where management_system_id = ${msId} and deleted_at is null and scheduled_at >= ${today}::date
     order by scheduled_at, id limit 1`.execute(trx);
  const row = rows[0];
  return row ? { id: row.id, date: row.scheduled_at } : null;
}

/** Slugs of the systems linked to a shareable record (`entity_ms_link`), the path system first. */
export async function linkedSystems(trx: Trx, entityType: string, entityId: string, firstMsId?: string): Promise<{ id: string; slug: string; code: string }[]> {
  const { rows } = await sql<{ id: string; slug: string; code: string }>`
    select m.id, m.slug, m.code from entity_ms_link l join management_system m on m.id = l.management_system_id and m.deleted_at is null
     where l.entity_type = ${entityType} and l.entity_id = ${entityId} and l.deleted_at is null
     order by (m.id = ${firstMsId ?? null}::uuid) desc nulls last, l.is_primary desc, m.slug`.execute(trx);
  return rows;
}

/**
 * Queues `freshness.recompute` for a system in the command's transaction (E.2: 5 second debounce, singleton per
 * organisation and system, `fr:<org>:<ms>` as `freshnessRecomputeKey` builds it), so the job commits or rolls back
 * with the change it follows.
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

/** The user's handle and display name (texts that name a person). */
export async function personOf(trx: Trx, userId: string | null): Promise<{ handle: string; name: string } | null> {
  if (!userId) return null;
  const { rows } = await sql<{ handle: string; display_name: string }>`
    select handle, display_name from platform.app_user where id = ${userId}`.execute(trx);
  const row = rows[0];
  return row ? { handle: row.handle, name: row.display_name } : null;
}

/** True for a PostgreSQL error raised by the BR-43 trigger (`platform.prep_task_before_audit`). */
export function isBr43TriggerError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return !!e && e.code === '23514' && typeof e.message === 'string' && e.message.startsWith('BR-43');
}

/**
 * The C.13 row the caller performs for `(from, to)` on a machine's transition route (D.3, F.7), as WP-20's
 * `pickTransition` does it: no row gives 422 with the rule of a rejection, else 409; rows only the system performs
 * give 409; the first row granted in full wins, an own-scoped grant needs the record to be the caller's, else 403.
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
  if (own) throw new ForbiddenError('Only the holder of this record can make this change');
  throw new ForbiddenError(`This change needs ${[...new Set(userRows.map((r) => r.permission))].join(' or ')}`);
}

/** 400 `validation` for request members a C.13 row requires (`requires`, for example `note`). */
export function assertRequires(row: Transition, body: Readonly<Record<string, unknown>>): void {
  const missing = (row.requires ?? []).filter((name) => {
    const value = body[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing.length > 0) {
    throw new ValidationError(
      missing.map((name) => ({ path: `body.${name}`, message: `Required for ${row.from ?? 'a new record'} to ${row.to}` })),
      'The transition needs more information',
    );
  }
}
