// Operating criteria of an applicability entry (D.3 `PUT /ms/{ms}/applicability/{id}/operating-criteria`, WP-36): the
// frequency at which the entry needs evidence (one of the edition's `ref.evidence_frequency_rule` codes) and its
// description. The change moves the entry's ETag, is audited as `applicability.updated` and queues
// `freshness.recompute` for the entry in the same transaction, because the freshness bands follow the frequency.
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, OperatingCriteriaRequest } from '@mscd/shared';
import { sql } from 'kysely';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { AUDIT_WRITER, RECORD_RESOLVER, type AuditWriter, type Principal, type RecordResolver, type Trx } from '../../common/tokens';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { assertFrequency, bump, commandResult, editionOf, enqueueFreshness, orgOf, refOf } from './support';

const ENTITY = 'applicability_entry';

@Injectable()
export class OperatingCriteriaService {
  constructor(
    private readonly tenancy: TenantScope,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  async set(principal: Principal, ms: string, id: string, body: OperatingCriteriaRequest): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const row = record.row as { id: string; target_type: 'catalogue_item' | 'requirement'; catalogue_item_id: string | null; requirement_id: string | null; updated_at: Date };
      await assertFrequency(trx, await editionOf(trx, record.ms.id), body.frequencyCode);
      const code = await businessIdOf(trx, row);
      const current = await trx
        .selectFrom('operating_criteria')
        .select(['id', 'frequency_code', 'description'])
        .where('applicability_entry_id', '=', row.id)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      const description = body.description !== undefined ? body.description : (current?.description ?? null);
      const before = { frequency_code: current?.frequency_code ?? null, description: current?.description ?? null };
      const after = { frequency_code: body.frequencyCode, description };
      if (before.frequency_code === after.frequency_code && before.description === after.description) {
        return commandResult([], {
          ref: refOf('implementation', ENTITY, row.id, code, new Date(row.updated_at)),
          message: ['Nothing to change', 'Tidak ada yang diubah'],
        });
      }
      if (current) {
        await trx
          .updateTable('operating_criteria')
          .set({ frequency_code: body.frequencyCode, description, updated_at: sql<Date>`now()`, updated_by: actor })
          .where('id', '=', current.id)
          .execute();
      } else {
        await trx
          .insertInto('operating_criteria')
          .values({ management_system_id: record.ms.id, applicability_entry_id: row.id, frequency_code: body.frequencyCode, description, created_by: actor, updated_by: actor })
          .execute();
      }
      const updatedAt = await bump(trx, ENTITY, row.id, { updated_by: actor });
      const changedBefore: Record<string, unknown> = {};
      const changedAfter: Record<string, unknown> = {};
      for (const key of ['frequency_code', 'description'] as const) {
        if (before[key] !== after[key]) {
          changedBefore[key] = before[key];
          changedAfter[key] = after[key];
        }
      }
      await this.audit.record(trx, { action: 'applicability.updated', msId: record.ms.id, entityType: ENTITY, entityId: row.id, entityCode: code, before: changedBefore, after: changedAfter });
      await enqueueFreshness(this.queue, trx, org, record.ms.id, { entryIds: [row.id] }, actor);
      return commandResult([record.ms.slug], { ref: refOf('implementation', ENTITY, row.id, code, updatedAt) });
    });
  }
}

/** G.5 business id of an entry: the catalogue item code, or `Cl. ` plus the requirement code. */
async function businessIdOf(trx: Trx, row: { target_type: 'catalogue_item' | 'requirement'; catalogue_item_id: string | null; requirement_id: string | null }): Promise<string> {
  const { rows } = row.target_type === 'catalogue_item'
    ? await sql<{ code: string }>`select item_code as code from ref.catalogue_item where id = ${row.catalogue_item_id}`.execute(trx)
    : await sql<{ code: string }>`select requirement_code as code from ref.requirement where id = ${row.requirement_id}`.execute(trx);
  const code = rows[0]?.code ?? '';
  return row.target_type === 'catalogue_item' ? code : `Cl. ${code}`;
}
