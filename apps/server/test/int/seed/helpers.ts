// Helpers of the demo seed tests (WP-14): queries in an organisation's scope and the stage record counts of C.10.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../src/db/types';
import { inScope } from '../db/helpers';

export const ORG_IDS = {
  ndt: '00000000-0000-4000-8000-00000000a001',
  bsd: '00000000-0000-4000-8000-00000000a002',
  rmn: '00000000-0000-4000-8000-00000000a003',
  tst: '00000000-0000-4000-8000-00000000a004',
} as const;
export type OrgSlug = keyof typeof ORG_IDS;
export const ORG_SLUGS = Object.keys(ORG_IDS) as OrgSlug[];

/** Runs `fn` as the migrator in an organisation's scope (its schema first on the path, platform scope on). */
export function inOrg<T>(migrator: Kysely<DB>, org: OrgSlug, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return inScope(migrator, { orgId: ORG_IDS[org], schema: `org_${org}`, platformScope: true }, fn);
}

/** Runs `fn` as the migrator with platform scope (organisation-scoped platform tables, D-31). */
export function inPlatform<T>(migrator: Kysely<DB>, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return inScope(migrator, { platformScope: true }, fn);
}

/** Number of rows of a query result's `count` column. */
export async function count(query: Promise<{ rows: { count: string | number }[] }>): Promise<number> {
  return Number((await query).rows[0]?.count ?? 0);
}

/**
 * Record count of a chain stage of a system (C.10 `rec`): rows of the stage's entity type in the system (shareable
 * types through `entity_ms_link`, risks also by risk profile), applicability entries for applicability and
 * justification stages, the system's documents and evidence.
 */
export async function stageRecordCount(trx: Transaction<DB>, msSlug: string, stageKey: string): Promise<number> {
  const def = (
    await sql<{ source: string; entity_type: string | null; risk_profile_code: string | null }>`
      select d.source, d.entity_type, d.risk_profile_code
      from management_system m join ref.traceability_chain_def d on d.framework_version_id = m.framework_version_id
      where m.slug = ${msSlug} and d.stage_key = ${stageKey}`.execute(trx)
  ).rows[0];
  if (!def) throw new Error(`No stage ${stageKey} for ${msSlug}`);
  const ms = sql`(select id from management_system where slug = ${msSlug})`;
  switch (def.source) {
    case 'applicability':
    case 'justification':
      return count(sql<{ count: string }>`select count(*) from applicability_entry where management_system_id = ${ms} and deleted_at is null`.execute(trx));
    case 'document':
      return count(sql<{ count: string }>`select count(*) from entity_ms_link where entity_type = 'document' and management_system_id = ${ms} and deleted_at is null`.execute(trx));
    case 'evidence':
      return count(sql<{ count: string }>`select count(*) from evidence_target where management_system_id = ${ms} and deleted_at is null`.execute(trx));
    default: {
      const table = def.entity_type!;
      if (['context_issue', 'risk', 'metric'].includes(table)) {
        return count(
          sql<{ count: string }>`select count(*) from ${sql.table(table)} r join entity_ms_link l on l.entity_id = r.id and l.entity_type = ${table}
            where l.management_system_id = ${ms} and l.deleted_at is null and r.deleted_at is null
              ${table === 'risk' ? sql`and r.risk_profile_code = ${def.risk_profile_code}` : sql``}`.execute(trx),
        );
      }
      return count(sql<{ count: string }>`select count(*) from ${sql.table(table)} where management_system_id = ${ms} and deleted_at is null`.execute(trx));
    }
  }
}
