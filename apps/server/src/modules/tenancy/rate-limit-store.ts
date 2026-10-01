// PostgreSQL store of the rate limits (build plan F.3): `platform.rate_limit_bucket`, one fixed window per key,
// incremented with `INSERT ... ON CONFLICT DO UPDATE SET hits = hits + 1`. A key whose window has passed starts a
// new window at its next hit; `cleanup.expired` (WP-22) deletes expired rows.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DATABASE, type AppDatabase } from '../../db/database.module';

export interface RateLimitHit {
  /** Hits in the current window, this one included. */
  current: number;
  /** Milliseconds until the window ends. */
  ttlMs: number;
}

/** Backend of the rate limit plugin's store (`src/modules/platform/rate-limit.ts`). */
export interface RateLimitBackend {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

/** Injection token of the rate limit backend. */
export const RATE_LIMIT_BACKEND = Symbol.for('mscd.rateLimitBackend');

@Injectable()
export class RateLimitBucketStore implements RateLimitBackend {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    if (key.length > 200) throw new Error('Rate limit key longer than 200 characters');
    const window = Math.max(1, Math.trunc(windowMs));
    const { rows } = await sql<{ hits: number; ttl_ms: string }>`
      insert into platform.rate_limit_bucket as b (key, window_start, hits, expires_at)
      values (${key}, clock_timestamp(), 1, clock_timestamp() + ${window} * interval '1 millisecond')
      on conflict (key) do update set
        window_start = case when b.expires_at <= clock_timestamp() then clock_timestamp() else b.window_start end,
        hits = case when b.expires_at <= clock_timestamp() then 1 else b.hits + 1 end,
        expires_at = case when b.expires_at <= clock_timestamp()
                          then clock_timestamp() + ${window} * interval '1 millisecond' else b.expires_at end
      returning hits, greatest(0, ceil(extract(epoch from (expires_at - clock_timestamp())) * 1000))::bigint as ttl_ms`.execute(this.db);
    const row = rows[0]!;
    return { current: Number(row.hits), ttlMs: Number(row.ttl_ms) };
  }

  /** Deletes buckets whose window ended; returns the number of rows removed. */
  async purgeExpired(): Promise<number> {
    const result = await this.db.deleteFrom('platform.rate_limit_bucket').where('expires_at', '<=', sql<Date>`now()`).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
