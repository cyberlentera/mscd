// Shared steps of the implementation commands (build plan D.1, D.3, C.13, F.7): picking the C.13 row a caller may
// perform, request members a row requires, the organisation date and the instant of validity windows, record refs
// with their new ETag, and the `freshness.recompute` job sent in the command's transaction (E.2).
import {
  rejectionFor, transitionsVia, type CommandResult, type MachineEntity, type Pair, type RecordRef, type Transition, type Warning,
} from '@mscd/shared';
import type { Clock } from '../../common/clock';
import { localDate, startOfLocalDay } from '../../common/dates';
import { etagOf } from '../../common/etag';
import type { JobQueue } from '../../common/jobs/job-queue';
import { BusinessRuleError, ForbiddenError, NotFoundError, TransitionNotAllowedError, ValidationError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import type { AuthzState, Principal, TenantInfo, Trx } from '../../common/tokens';
import { ruleMessageKey, ruleMessages } from '../rules';

/** The organisation of the caller's session (every implementation route is ms-scoped, so there is one). */
export function orgOf(principal: Principal): TenantInfo {
  if (!principal.org) throw new NotFoundError('No organisation is selected');
  return principal.org;
}

/** Today in the organisation (D-07: `demo.fixed_today` in demo and test installs). */
export function todayOf(clock: Clock, org: Pick<TenantInfo, 'timeZone'>): string {
  return clock.todayIn(org.timeZone);
}

/**
 * The instant the C.12 validity windows are measured at: `clock.now()`, or with `demo.fixed_today` the same local
 * time of day on the fixed date, so windows agree with the fixed "today" (as the freshness jobs measure them).
 */
export function windowNowOf(clock: Clock, org: Pick<TenantInfo, 'timeZone'>): Date {
  const now = clock.now();
  const fixed = clock.fixedToday;
  if (!fixed) return now;
  const shift = startOfLocalDay(fixed, org.timeZone).getTime() - startOfLocalDay(localDate(now, org.timeZone), org.timeZone).getTime();
  return new Date(now.getTime() + shift);
}

/**
 * The C.13 row the caller performs for `(from, to)` on the machine's transition route (D.3, F.7):
 * - no row: 422 with the rule of a rejection of the same route, else 409 `transition-not-allowed`;
 * - rows only the system performs (`permission: null`): 409;
 * - the first row whose permission the guard granted in full, or granted own-scoped on a row marked `own` when the
 *   caller owns the record; a caller who holds only an own-scoped grant on someone else's record gets 403, as does a
 *   caller without any of the rows' permissions (the guard admitted them through another row of the machine).
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

/** 400 `validation` for request members a C.13 row requires (`requires`, for example `rejectReason`). */
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

/** A record ref with the ETag of its new version (D.1 Concurrency, A-21). */
export function refOf(entityType: string, id: string, code: string, updatedAt: Date): RecordRef {
  return { module: 'implementation', entityType, id, code, etag: etagOf(updatedAt) };
}

/** A `CommandResult` (D.2); empty optional members are left out. */
export function commandResult(changed: readonly string[], extra: { ref?: RecordRef; warnings?: readonly Warning[]; message?: Pair; data?: unknown } = {}): CommandResult {
  return {
    ok: true,
    changed: [...new Set(changed)],
    ...(extra.message ? { message: extra.message } : {}),
    ...(extra.warnings && extra.warnings.length > 0 ? { warnings: [...extra.warnings] } : {}),
    ...(extra.ref ? { ref: extra.ref } : {}),
    ...(extra.data !== undefined ? { data: extra.data } : {}),
  };
}

/**
 * Queues `freshness.recompute` for a system in the command's transaction (E.2: 5 second debounce, singleton per
 * organisation and system), so the job commits or rolls back with the change it follows.
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
    { singletonKey: `fr:${org.id}:${msId}`, startAfterSeconds: 5 },
    trx,
  );
}
