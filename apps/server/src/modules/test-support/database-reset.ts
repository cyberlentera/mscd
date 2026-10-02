// Drops the api's database and creates it again from a template database (D.3 `POST /test/reset`), through the
// administrator URL of `test.admin_database_url_file`. Database-level privileges are not copied by
// `CREATE DATABASE ... TEMPLATE` (C.2), so the grants of the template are applied to the new database.
import pg from 'pg';

/** A plain PostgreSQL identifier (the profile schema allows only these for `test.template_database`). */
const PLAIN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface RecreateDatabaseOptions {
  /** Administrator URL (superuser or a role with CREATEDB that owns the database). Any database of the server. */
  adminUrl: string;
  /** The database to drop and create, the one the api's role URLs name. */
  database: string;
  /** The template it is created from. */
  template: string;
}

/** Name of the database a PostgreSQL URL names (its path). */
export function databaseOf(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!name) throw new Error('The database URL names no database');
  return name;
}

/** A privilege of the template, as `aclexplode` lists it. */
interface DatabaseGrant {
  grantee: string | null;
  privilege_type: string;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * `DROP DATABASE <database> WITH (FORCE)` (connections of other clients are ended) and
 * `CREATE DATABASE <database> TEMPLATE <template>`, then the database grants of the template.
 */
export async function recreateDatabase(options: RecreateDatabaseOptions): Promise<void> {
  const { database, template } = options;
  if (!PLAIN_NAME.test(database)) throw new Error(`The database name ${JSON.stringify(database)} is not a plain name`);
  if (!PLAIN_NAME.test(template)) throw new Error(`The template name ${JSON.stringify(template)} is not a plain name`);
  if (database === template) throw new Error('The template database must differ from the database it recreates');
  const url = new URL(options.adminUrl);
  // The administrator cannot drop the database it is connected to.
  if (databaseOf(options.adminUrl) === database) url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString(), application_name: 'mscd-test-reset' });
  client.on('notice', () => undefined);
  client.on('error', () => undefined);
  await client.connect();
  try {
    const found = await client.query<{ datacl: string | null }>('select datacl::text from pg_database where datname = $1', [template]);
    if (found.rowCount === 0) throw new Error(`The template database ${template} does not exist`);
    const grants =
      found.rows[0]!.datacl === null
        ? null
        : (
            await client.query<DatabaseGrant>(
              `select case when a.grantee = 0 then null else a.grantee::regrole::text end as grantee, a.privilege_type
                 from pg_database d, aclexplode(d.datacl) a where d.datname = $1`,
              [template],
            )
          ).rows;
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoteIdent(database)} TEMPLATE ${quoteIdent(template)}`);
    if (grants !== null) {
      // Same access as the template: PUBLIC keeps only what the template gives it.
      await client.query(`REVOKE ALL ON DATABASE ${quoteIdent(database)} FROM PUBLIC`);
      for (const grant of grants) {
        if (!/^[A-Z ]+$/.test(grant.privilege_type)) continue;
        const grantee = grant.grantee === null ? 'PUBLIC' : grant.grantee.startsWith('"') ? grant.grantee : quoteIdent(grant.grantee);
        await client.query(`GRANT ${grant.privilege_type} ON DATABASE ${quoteIdent(database)} TO ${grantee}`);
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
