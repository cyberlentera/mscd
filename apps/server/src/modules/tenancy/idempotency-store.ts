// Idempotency keys (build plan D.1): `platform.idempotency_key`, keyed by organisation, user and key, kept 24 hours.
// The row is claimed before the command runs and completed with the response afterwards; a repeat of the same
// request replays the stored response, a different request with the same key is a conflict. The table has forced
// RLS on `app.org_id` (D-31), so every statement runs in a transaction that sets the organisation: keys never
// replay across organisations.
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DATABASE, type AppDatabase } from '../../db/database.module';
import type { DB } from '../../db/types';

export const IDEMPOTENCY_TTL_HOURS = 24;

export interface IdempotencyScope {
  orgId: string;
  userId: string;
  key: string;
}

export type IdempotencyClaim =
  | { kind: 'claimed' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' }
  | { kind: 'in_progress' };

@Injectable()
export class IdempotencyStore {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /**
   * Claims the key for a request (`routeId`, `requestHash`). A concurrent claim of the same key waits for the first
   * transaction and then sees it in progress.
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
      if (inserted) return { kind: 'claimed' };
      const existing = await trx
        .selectFrom('platform.idempotency_key')
        .select(['request_hash', 'status', 'response'])
        .where('organization_id', '=', scope.orgId)
        .where('user_id', '=', scope.userId)
        .where('key', '=', scope.key)
        .executeTakeFirst();
      if (!existing) return { kind: 'in_progress' };
      if (existing.request_hash !== requestHash) return { kind: 'mismatch' };
      if (existing.status === null) return { kind: 'in_progress' };
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
