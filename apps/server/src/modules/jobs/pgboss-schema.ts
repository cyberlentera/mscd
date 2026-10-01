// C.3 step 3 of `migrate`: the pg-boss schema and its grants to mscd_app. Runs as mscd_migrator, which owns the
// schema; the application role gets data rights only (it never migrates pg-boss, `migrate: false` in the driver).
import { JOB_NAMES } from '@mscd/shared';
import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { PGBOSS_SCHEMA } from './pgboss-job-queue';

/** The grants of C.3 step 3. */
export const PGBOSS_GRANTS = [
  `GRANT USAGE ON SCHEMA ${PGBOSS_SCHEMA} TO mscd_app`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PGBOSS_SCHEMA} TO mscd_app`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${PGBOSS_SCHEMA} TO mscd_app`,
  `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${PGBOSS_SCHEMA} TO mscd_app`,
] as const;

export interface PgBossSchemaResult {
  /** Schema version before the step; null when pg-boss was not installed. */
  before: number | null;
  /** Schema version after the step. */
  after: number | null;
  /** Queues created by this run (one per E.2 job; existing queues are kept). */
  queuesCreated: number;
}

/**
 * Creates or migrates the pg-boss schema with the migrator's URL, creates one queue per E.2 job (`exclusive`
 * policy, see `pgboss-job-queue.ts`) and grants mscd_app the C.3 rights. Idempotent.
 */
export async function ensurePgBossSchema(migratorUrl: string): Promise<PgBossSchemaResult> {
  const before = await installedVersion(migratorUrl);
  const boss = new PgBoss({
    connectionString: migratorUrl,
    schema: PGBOSS_SCHEMA,
    application_name: 'mscd-migrate',
    max: 2,
    migrate: true,
    supervise: false,
    schedule: false,
    reindex: false,
  });
  boss.on('error', () => undefined);
  let queuesCreated = 0;
  await boss.start();
  try {
    const existing = new Set((await boss.getQueues()).map((q) => q.name));
    for (const name of JOB_NAMES) {
      if (existing.has(name)) continue;
      await boss.createQueue(name, { policy: 'exclusive' });
      queuesCreated += 1;
    }
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
  const client = new pg.Client({ connectionString: migratorUrl, application_name: 'mscd-migrate' });
  await client.connect();
  try {
    for (const statement of PGBOSS_GRANTS) await client.query(statement);
  } finally {
    await client.end();
  }
  return { before, after: await installedVersion(migratorUrl), queuesCreated };
}

/** The installed pg-boss schema version, or null when the schema does not exist. */
export async function installedVersion(connectionString: string): Promise<number | null> {
  const client = new pg.Client({ connectionString, application_name: 'mscd-migrate' });
  await client.connect();
  try {
    const found = await client.query<{ found: boolean }>(`SELECT to_regclass('${PGBOSS_SCHEMA}.version') IS NOT NULL AS found`);
    if (!found.rows[0]?.found) return null;
    const { rows } = await client.query<{ version: number }>(`SELECT version FROM ${PGBOSS_SCHEMA}.version LIMIT 1`);
    return rows[0] ? Number(rows[0].version) : null;
  } finally {
    await client.end();
  }
}
