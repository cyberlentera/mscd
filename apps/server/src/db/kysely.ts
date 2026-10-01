import { Logger } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { MscdConfig } from '../config/mscd-config';
import { GuardedPool, type PoolGuardMode } from './pool-guard';
import type { DB } from './types';

/** PostgreSQL `date`: returned as the `YYYY-MM-DD` string, never as a JavaScript Date (local dates, C.1). */
export const PG_DATE_OID = 1082;

export interface PoolOptions {
  connectionString: string;
  /** Maximum connections (profile `database.pool_max`). */
  max?: number;
  /** Shown in `pg_stat_activity.application_name`. */
  applicationName?: string;
  /** libpq `options`, for example `-c search_path=org_ndt,ext` on a dedicated migrator client. */
  options?: string;
  /** Called for errors of idle clients; without a handler such an error would end the process. */
  onError?: (error: Error) => void;
}

const typeParsers = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === PG_DATE_OID && format !== 'binary'
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export function createPgPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'mscd',
    options: options.options,
    types: typeParsers,
  });
  pool.on('error', (error) => {
    if (options.onError) options.onError(error);
    else process.stderr.write(`PostgreSQL idle client error: ${error.message}\n`);
  });
  return pool;
}

/** A Kysely instance on its own `pg` pool. */
export function createKysely<T = DB>(options: PoolOptions): Kysely<T> {
  return new Kysely<T>({ dialect: new PostgresDialect({ pool: createPgPool(options) }) });
}

export interface GuardedKysely<T> {
  db: Kysely<T>;
  guard: GuardedPool;
}

/** A Kysely instance on a pool whose checkouts pass the F.10 guard (`src/db/pool-guard.ts`). */
export function createGuardedKysely<T = DB>(
  options: PoolOptions & { guardMode: PoolGuardMode; sampleEvery?: number; onDirtyConnection?: (message: string) => void },
): GuardedKysely<T> {
  const logger = new Logger('PoolGuard');
  const guard = new GuardedPool(createPgPool(options), {
    mode: options.guardMode,
    sampleEvery: options.sampleEvery,
    onDirtyConnection: options.onDirtyConnection ?? ((message) => logger.error(message)),
  });
  return { db: new Kysely<T>({ dialect: new PostgresDialect({ pool: guard }) }), guard };
}

/** Guard mode of a configuration: every checkout in test profiles, one in a hundred otherwise (F.10). */
export function poolGuardMode(config: MscdConfig): PoolGuardMode {
  return config.profile.test !== undefined ? 'every' : 'sampled';
}

/**
 * The application database of the api and worker run modes (role `mscd_app`, D.4), as provided by
 * `DatabaseModule`, with the pool checkout guard of F.10.
 */
export function createAppDatabase(config: MscdConfig): Kysely<DB> {
  return createGuardedKysely<DB>({
    connectionString: config.databaseUrl('app'),
    max: config.profile.database.pool_max,
    applicationName: `mscd-${config.runMode}`,
    guardMode: poolGuardMode(config),
  }).db;
}
