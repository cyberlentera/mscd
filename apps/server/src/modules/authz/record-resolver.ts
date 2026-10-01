// RECORD_RESOLVER (build plan D.1 Records, F.7): every command that names a record resolves it here, inside the
// tenant transaction. The entity type must be one of `RECORD_ENTITY_TYPES`, the row must exist and not be deleted,
// and it must belong to the system of the path: its `management_system_id`, or for shareable types an
// `entity_ms_link` row to that system. Anything else is 404 before a record of another system is ever touched.
import { Injectable } from '@nestjs/common';
import { RECORD_ENTITY_TYPES, SHAREABLE_ENTITY_TYPES } from '@mscd/shared';
import { sql } from 'kysely';
import { NotFoundError } from '../../common/problems';
import type { MsRef, RecordResolver, ResolvedRecord, Trx } from '../../common/tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_SLUG = /^[a-z][a-z0-9-]{1,19}$/;
const RECORD_TYPES: ReadonlySet<string> = new Set(RECORD_ENTITY_TYPES);
const SHAREABLE_TYPES: ReadonlySet<string> = new Set(SHAREABLE_ENTITY_TYPES);

@Injectable()
export class TenantRecordResolver implements RecordResolver {
  async resolveMs(trx: Trx, ms: string): Promise<MsRef> {
    if (!MS_SLUG.test(ms)) throw new NotFoundError('Unknown management system');
    const row = await trx.selectFrom('management_system').select(['id', 'slug']).where('slug', '=', ms).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw new NotFoundError('Unknown management system');
    return { id: row.id, slug: row.slug };
  }

  async resolve(trx: Trx, ms: string, entityType: string, id: string, options: { forUpdate?: boolean } = {}): Promise<ResolvedRecord> {
    // The allow-list is checked before any query, so the table name is never taken from the request unchecked.
    if (!RECORD_TYPES.has(entityType) || !UUID.test(id)) throw new NotFoundError();
    const system = await this.resolveMs(trx, ms);
    const table = sql.table(entityType);
    const lock = options.forUpdate ? sql` for update of t` : sql``;
    const query = SHAREABLE_TYPES.has(entityType)
      ? sql<Record<string, unknown>>`select t.* from ${table} t
          where t.id = ${id} and t.deleted_at is null
            and exists (select 1 from entity_ms_link l
                        where l.entity_type = ${entityType} and l.entity_id = t.id
                          and l.management_system_id = ${system.id} and l.deleted_at is null)${lock}`
      : sql<Record<string, unknown>>`select t.* from ${table} t
          where t.id = ${id} and t.deleted_at is null and t.management_system_id = ${system.id}${lock}`;
    const { rows } = await query.execute(trx);
    const row = rows[0];
    if (!row) throw new NotFoundError();
    return { entityType: entityType as ResolvedRecord['entityType'], id, ms: system, row };
  }
}
