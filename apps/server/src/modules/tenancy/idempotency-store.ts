// Idempotency keys (build plan D.1): `platform.idempotency_key`, keyed by organisation, user and key, kept 24 hours.
// The row is claimed before the command runs and completed with the response afterwards; a repeat of the same
// request replays the stored response, a different request with the same key is a conflict. The table has forced
// RLS on `app.org_id` (D-31), so every statement runs in a transaction that sets the organisation: keys never
// replay across organisations.
//
// A claim without a stored response is "in progress" for a lease of `IDEMPOTENCY_LEASE_SECONDS` from `created_at`
// (a repeat gets 409 with `Retry-After`). When the lease has passed, the process that claimed the key is assumed
// gone (it died, or storing the response failed), and the same request may claim the key again and run. The
// command may then have run before: the lease trades that rare repeat for never blocking a key for 24 hours.
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DATABASE, type AppDatabase } from '../../db/database.module';
import type { DB } from '../../db/types';

export const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Seconds a claimed key stays "in progress" without a stored response. Longer than any command runs (statements stop
 * after 30 seconds, C.3; long work is queued as jobs), short enough that a lost response does not block the key.
 */
export const IDEMPOTENCY_LEASE_SECONDS = 300;

export interface IdempotencyScope {
  orgId: string;
  userId: string;
  key: string;
}

export type IdempotencyClaim =
  /** The request may run; `reclaimed` when it took over a claim whose lease had passed. */
  | { kind: 'claimed'; reclaimed: boolean }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' }
  /** Another request with the key is running; `retryAfter` is the number of seconds until its lease ends. */
  | { kind: 'in_progress'; retryAfter: number };

@Injectable()
export class IdempotencyStore {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /**
   * Claims the key for a request (`routeId`, `requestHash`). A concurrent claim of the same key waits for the first
   * transaction and then sees it in progress. A claim of the same request whose lease has passed is taken over.
   */
  async claim(scope: IdempotencyScope, routeId: string, requestHash: string): Promise<IdempotencyClaim> {
    return this.inOrg(scope, async (trx) => {
      await trx
        .deleteFrom('platform.idempotency_key')
        .where('organization_id', '=', scope.orgId)
        .where('user_id', '=', scope.userId)
        .where('key', '=', scope.key)
        .where('expires_at', '<=', sql<Date>`now()`)
        .execute();
      const inserted = await trx
        .insertInto('platform.idempotency_key')
        .values({
          organization_id: scope.orgId,
          user_id: scope.userId,
          key: scope.key,
          route: routeId,
          request_hash: requestHash,
          status: null,
          response: null,
          expires_at: sql<Date>`now() + ${IDEMPOTENCY_TTL_HOURS} * interval '1 hour'`,
        })
        .onConflict((oc) => oc.columns(['organization_id', 'user_id', 'key']).doNothing())
        .returning('key')
        .executeTakeFirst();
      if (inserted) return { kind: 'claimed', reclaimed: false };
      // Same request, no response and the lease has passed: take the claim over (the row lock serialises takers).
      const reclaimed = await trx
        .updateTable('platform.idempotency_key')
        .set({
          route: routeId,
          created_at: sql<Date>`now()`,
          expires_at: sql<Date>`now() + ${IDEMPOTENCY_TTL_HOURS} * interval '1 hour'`,
        })
        .where('organization_id', '=', scope.orgId)
        .where('user_id', '=', scope.userId)
        .where('key', '=', scope.key)
        .where('request_hash', '=', requestHash)
        .where('status', 'is', null)
        .where('created_at', '<=', sql<Date>`now() - ${IDEMPOTENCY_LEASE_SECONDS} * interval '1 second'`)
        .returning('key')
        .executeTakeFirst();
      if (reclaimed) return { kind: 'claimed', reclaimed: true };
      const existing = await trx
        .selectFrom('platform.idempotency_key')
        .select([
          'request_hash',
          'status',
          'response',
          sql<number>`ceil(extract(epoch from created_at + ${IDEMPOTENCY_LEASE_SECONDS} * interval '1 second' - now()))::int`.as('lease_left'),
        ])
        .where('organization_id', '=', scope.orgId)
        .where('user_id', '=', scope.userId)
        .where('key', '=', scope.key)
        .executeTakeFirst();
      if (!existing) return { kind: 'in_progress', retryAfter: 1 };
      if (existing.request_hash !== requestHash) return { kind: 'mismatch' };
      if (existing.status === null) return { kind: 'in_progress', retryAfter: Math.max(1, Number(existing.lease_left)) };
      const stored = existing.response as { body?: unknown } | null;
      return { kind: 'replay', status: existing.status, body: stored?.body };
    });
  }

  /** Stores the response of a claimed key. */
  async complete(scope: IdempotencyScope, status: number, body: unknown): Promise<void> {
    await this.inOrg(scope, (trx) =>
      trx
        .updateTable('platform.idempotency_key')
        .set({ status, response: JSON.stringify({ body: body === undefined ? null : body }) })
        .where('organization_id', '=', scope.orgId)
        .where('user_id', '=', scope.userId)
        .where('key', '=', scope.key)
        .execute(),
    );
  }

  /** Releases a claimed key whose request failed, so the client may retry it. */
  async release(scope: IdempotencyScope): Promise<void> {
    await this.inOrg(scope, (trx) =>
      trx
        .deleteFrom('platform.idempotency_key')
        .where('organization_id', '=', scope.orgId)
        .where('user_id', '=', scope.userId)
        .where('key', '=', scope.key)
        .where('status', 'is', null)
        .execute(),
    );
  }

  private inOrg<T>(scope: IdempotencyScope, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${scope.orgId}, true), set_config('app.user_id', ${scope.userId}, true)`.execute(trx);
      return fn(trx);
    });
  }
}
