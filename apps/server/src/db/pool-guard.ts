// Pool checkout guard (build plan F.10). Tenant settings are transaction-local (`set_config(..., true)` in
// `withTenant`), so a connection handed out by the pool must carry none of them: `app.org_id`, `app.user_id` and
// `app.platform_scope` empty and `search_path` equal to the role default. A connection that fails the check is
// destroyed (never reused) and the event is logged; the pool then hands out another connection. Test profiles check
// every checkout; production checks every hundredth checkout and every checkout after a query error on that
// connection.
import type { PostgresPool, PostgresPoolClient } from 'kysely';
import type pg from 'pg';

export type PoolGuardMode = 'every' | 'sampled' | 'off';

export interface PoolGuardOptions {
  mode: PoolGuardMode;
  /** With mode `sampled`: check one checkout in this many (default 100). */
  sampleEvery?: number;
  /** Receives one message per destroyed connection. */
  onDirtyConnection: (message: string) => void;
}

interface ClientState {
  /** A query on this connection failed since its last check. */
  errored: boolean;
}

interface SettingsRow {
  org_id: string;
  user_id: string;
  platform_scope: string;
  search_path: string;
  default_search_path: string;
}

/** Reads the settings the guard compares; one round trip. */
export const POOL_GUARD_QUERY = `select coalesce(current_setting('app.org_id', true), '') as org_id,
       coalesce(current_setting('app.user_id', true), '') as user_id,
       coalesce(current_setting('app.platform_scope', true), '') as platform_scope,
       s.setting as search_path, s.reset_val as default_search_path
  from pg_catalog.pg_settings s where s.name = 'search_path'`;

/** Describes what is wrong with a connection's settings, or null when it is clean. */
export function dirtySettings(row: SettingsRow): string | null {
  const problems: string[] = [];
  if (row.org_id !== '') problems.push('app.org_id is set');
  if (row.user_id !== '') problems.push('app.user_id is set');
  if (row.platform_scope !== '') problems.push('app.platform_scope is set');
  if (row.search_path !== row.default_search_path) {
    problems.push(`search_path is ${JSON.stringify(row.search_path)} instead of the role default ${JSON.stringify(row.default_search_path)}`);
  }
  return problems.length > 0 ? problems.join(', ') : null;
}

/** Most connections the guard destroys in a row before it gives up on one checkout. */
const MAX_ATTEMPTS = 5;

/**
 * A pool for Kysely's `PostgresDialect` that checks connections at checkout as F.10 describes. `end()` ends the
 * underlying pool.
 */
export class GuardedPool implements PostgresPool {
  private readonly states = new WeakMap<object, ClientState>();
  private checkouts = 0;
  /** Connections destroyed by the guard since start (tests and metrics). */
  destroyed = 0;

  constructor(
    readonly pool: pg.Pool,
    private readonly options: PoolGuardOptions,
  ) {}

  async connect(): Promise<PostgresPoolClient> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const client = (await this.pool.connect()) as unknown as pg.PoolClient;
      let state = this.states.get(client);
      if (!state) {
        state = { errored: false };
        this.states.set(client, state);
      }
      this.checkouts += 1;
      if (this.shouldCheck(state)) {
        let problem: string | null;
        try {
          const result = await client.query<SettingsRow>(POOL_GUARD_QUERY);
          problem = dirtySettings(result.rows[0]!);
        } catch (error) {
          client.release(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
        if (problem) {
          this.destroyed += 1;
          this.options.onDirtyConnection(
            `Destroyed a pooled database connection with session-level settings (${problem}); a transaction-local setting leaked (F.10)`,
          );
          client.release(new Error(`pool guard: ${problem}`));
          continue;
        }
        state.errored = false;
      }
      return this.wrap(client, state);
    }
    throw new Error(`Pool guard: ${MAX_ATTEMPTS} connections in a row had session-level settings`);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  private shouldCheck(state: ClientState): boolean {
    switch (this.options.mode) {
      case 'every':
        return true;
      case 'off':
        return false;
      case 'sampled':
        return state.errored || this.checkouts % (this.options.sampleEvery ?? 100) === 0;
    }
  }

  /** The client as Kysely uses it; failed queries mark the connection for a check at its next checkout. */
  private wrap(client: pg.PoolClient, state: ClientState): PostgresPoolClient {
    const wrapped = {
      query: (...args: unknown[]) => {
        const result = (client.query as (...a: unknown[]) => unknown)(...args);
        if (result && typeof (result as Promise<unknown>).then === 'function' && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch(() => {
            state.errored = true;
          });
        }
        return result;
      },
      release: (destroy?: boolean | Error) => {
        client.release(destroy);
      },
    };
    return wrapped as unknown as PostgresPoolClient;
  }
}
