// Readiness checks of C.3 for the api and worker: (a) the newest platform migration compiled into this build
// (`MIGRATIONS_EXPECTED`) is applied; (b) no role other than the migrator, superusers, predefined `pg_*` roles and
// the database owner can create objects in `public`, `ext`, `platform`, `ref` or an `org_*` schema, and `PUBLIC`
// can create objects in no schema at all. The detail of a failing check names the migration, or each role and
// schema.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { DATABASE, type AppDatabase } from '../../db/database.module';
import { MIGRATIONS_EXPECTED } from '../../generated/build-info';
import { ReadinessService } from '../platform/readiness.service';

/** C.3 (b): roles that may create objects where only the migrator should, and `PUBLIC` anywhere. */
export const SCHEMA_CREATE_PRIVILEGE_QUERY = sql<{ schema_name: string; role_name: string }>`
  select n.nspname::text as schema_name, r.rolname::text as role_name
  from pg_catalog.pg_namespace n
  cross join pg_catalog.pg_roles r
  where (n.nspname in ('public', 'ext', 'platform', 'ref') or n.nspname ~ '^org_[a-z0-9_]{1,59}$')
    and r.rolname <> 'mscd_migrator'
    and not r.rolsuper
    and r.rolname !~ '^pg_'
    and r.oid <> (select d.datdba from pg_catalog.pg_database d where d.datname = current_database())
    and has_schema_privilege(r.oid, n.oid, 'CREATE')
  union all
  select n.nspname::text, 'PUBLIC'
  from pg_catalog.pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
  where a.grantee = 0 and a.privilege_type = 'CREATE'
  order by 1, 2`;

@Injectable()
export class SchemaReadiness implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly db: AppDatabase,
    private readonly readiness: ReadinessService,
  ) {}

  onModuleInit(): void {
    this.readiness.register({ name: 'migrations', after: 'database', check: () => this.checkMigrations() });
    this.readiness.register({ name: 'schema-privileges', after: 'database', check: () => this.checkSchemaPrivileges() });
  }

  /** Passes when the newest platform migration of this build is applied (C.3 a). */
  async checkMigrations(expected: readonly string[] = MIGRATIONS_EXPECTED): Promise<string> {
    const newest = expected.at(-1);
    if (!newest) return 'no platform migrations in this build';
    const row = await this.db.selectFrom('platform.kysely_migration').select('name').where('name', '=', newest).executeTakeFirst();
    if (!row) throw new Error(`platform migration ${newest} is not applied; run mscd-server migrate`);
    return `platform at ${newest}`;
  }

  /** Passes when no unexpected role can create objects in the MSCD schemas (C.3 b). */
  async checkSchemaPrivileges(): Promise<string> {
    const { rows } = await SCHEMA_CREATE_PRIVILEGE_QUERY.execute(this.db);
    if (rows.length > 0) {
      const list = rows.map((r) => `${r.role_name} can create objects in ${r.schema_name}`).join('; ');
      throw new Error(`unsafe schema privileges: ${list}`);
    }
    return 'only the migrator creates objects';
  }
}
