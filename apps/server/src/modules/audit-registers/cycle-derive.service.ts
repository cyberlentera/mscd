// `cycle.derive` (E.2, TS 6.8, WP-37): for each cycle item (`cycle_requirement_status`) of the current certification
// cycle of a system whose definition (`ref.cycle_requirement_def.derivation`) names a derivation, decides whether
// the requirement is met and then sets the item `done` (actor system, audit `cycle_item.updated`); otherwise the
// stored status is kept, so a derivation never lowers a status. Derivation kinds:
// - `management_review_closed`: a `closed` management review linked to the system, closed within the cycle, whose
//   mandatory inputs of this system all have content;
// - `risk_assessment_current` (`months`, default 12): the system has risks and every risk linked to it was assessed
//   within the window;
// - `internal_audit_done`: a finding of the system with source `internal_audit` raised within the cycle;
// - `exercise_performed`: an exercise of the system performed within the cycle.
// Unknown kinds are skipped with a warning. The demo packs carry no derivations (G.7), so their items keep the
// seeded statuses.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { AUDIT_WRITER, SYSTEM_USER_ID, type AuditWriter, type Trx } from '../../common/tokens';

/** E.2 singleton key of `cycle.derive`: `cd:<org>:<ms or all>`. */
export function cycleDeriveKey(orgId: string, msId?: string | null): string {
  return `cd:${orgId}:${msId ?? 'all'}`;
}

const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, kind: 'system' as const };

export const DERIVATION_KINDS = ['management_review_closed', 'risk_assessment_current', 'internal_audit_done', 'exercise_performed'] as const;
export type DerivationKind = (typeof DERIVATION_KINDS)[number];

export interface DerivedItem {
  itemId: string;
  msId: string;
  kind: string;
  /** The requirement is met by the data. */
  met: boolean;
  /** The item moved to `done` in this run. */
  changed: boolean;
}

export interface CycleDeriveResult {
  systems: number;
  items: DerivedItem[];
  /** Items whose derivation kind is unknown (skipped). */
  skipped: { itemId: string; kind: string }[];
}

interface ItemRow {
  id: string;
  management_system_id: string;
  title: string;
  requirement_code: string;
  status: string;
  derivation: { kind?: unknown; months?: unknown } | null;
  cycle_start: string;
  cycle_end: string;
}

@Injectable()
export class CycleDeriveService {
  private readonly logger = new Logger('cycle.derive');

  constructor(@Inject(AUDIT_WRITER) private readonly audit: AuditWriter) {}

  /** Runs the derivations of one system, or of every system of the organisation, in the caller's tenant transaction. */
  async derive(trx: Trx, today: string, msId?: string | null): Promise<CycleDeriveResult> {
    // The current cycle of each system is its latest one (as the read model shows cycle items).
    const { rows: items } = await sql<ItemRow>`
      with current_cycle as (
        select distinct on (c.management_system_id) c.management_system_id, c.id, c.cycle_start, c.cycle_end
          from certification_cycle c join management_system m on m.id = c.management_system_id and m.deleted_at is null and m.status <> 'archived'
         where c.deleted_at is null and (${msId ?? null}::uuid is null or c.management_system_id = ${msId ?? null}::uuid)
         order by c.management_system_id, c.cycle_start desc, c.created_at desc)
      select s.id, s.management_system_id, s.title, s.requirement_code, s.status, d.derivation, cc.cycle_start, cc.cycle_end
        from cycle_requirement_status s
        join current_cycle cc on cc.id = s.certification_cycle_id
        join ref.cycle_requirement_def d on d.id = s.cycle_requirement_def_id
       where s.deleted_at is null and d.derivation is not null and jsonb_typeof(d.derivation) = 'object'
       order by s.management_system_id, s.position
       for update of s`.execute(trx);
    const result: CycleDeriveResult = { systems: new Set(items.map((i) => i.management_system_id)).size, items: [], skipped: [] };
    for (const item of items) {
      const kind = typeof item.derivation?.kind === 'string' ? item.derivation.kind : '';
      if (!(DERIVATION_KINDS as readonly string[]).includes(kind)) {
        this.logger.warn({ itemId: item.id, msId: item.management_system_id, kind }, 'cycle.derive: unknown derivation kind skipped');
        result.skipped.push({ itemId: item.id, kind });
        continue;
      }
      const met = await this.isMet(trx, kind as DerivationKind, item, today);
      const changed = met && item.status !== 'done';
      if (changed) {
        await sql`update cycle_requirement_status
                     set status = 'done', updated_by = ${SYSTEM_USER_ID},
                         updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
                   where id = ${item.id}`.execute(trx);
        await this.audit.record(trx, {
          action: 'cycle_item.updated',
          actor: SYSTEM_ACTOR,
          msId: item.management_system_id,
          entityType: 'cycle_requirement_status',
          entityId: item.id,
          entityCode: item.requirement_code,
          before: { status: item.status },
          after: { status: 'done', derivation: kind },
        });
      }
      result.items.push({ itemId: item.id, msId: item.management_system_id, kind, met, changed });
    }
    return result;
  }

  private async isMet(trx: Trx, kind: DerivationKind, item: ItemRow, today: string): Promise<boolean> {
    const ms = item.management_system_id;
    switch (kind) {
      case 'management_review_closed': {
        const { rows } = await sql<{ found: boolean }>`
          select exists (
            select 1 from management_review r
              join entity_ms_link l on l.entity_type = 'management_review' and l.entity_id = r.id and l.management_system_id = ${ms} and l.deleted_at is null
             where r.deleted_at is null and r.status = 'closed'
               and r.closed_at between ${item.cycle_start}::date and ${item.cycle_end}::date
               and not exists (
                 select 1 from management_system m
                   join ref.review_input_def d on d.framework_version_id = m.framework_version_id and d.mandatory
                   left join management_review_input i on i.management_review_id = r.id and i.review_input_def_id = d.id
                                                      and i.management_system_id = m.id and i.deleted_at is null
                  where m.id = ${ms} and (i.content is null or btrim(i.content) = ''))
          ) as found`.execute(trx);
        return rows[0]?.found === true;
      }
      case 'risk_assessment_current': {
        const raw = Number(item.derivation?.months);
        const months = Number.isInteger(raw) && raw > 0 ? raw : 12;
        const { rows } = await sql<{ total: number; current: number }>`
          select count(*)::int as total,
                 count(*) filter (where r.assessed_at is not null and r.assessed_at >= (${today}::date - make_interval(months => ${months}))::date)::int as current
            from risk r
           where r.deleted_at is null
             and exists (select 1 from entity_ms_link l where l.entity_type = 'risk' and l.entity_id = r.id and l.management_system_id = ${ms} and l.deleted_at is null)`.execute(trx);
        const counts = rows[0];
        return !!counts && counts.total > 0 && counts.current === counts.total;
      }
      case 'internal_audit_done': {
        const { rows } = await sql<{ found: boolean }>`
          select exists (
            select 1 from finding f
             where f.management_system_id = ${ms} and f.deleted_at is null and f.source = 'internal_audit'
               and f.raised_at between ${item.cycle_start}::date and ${item.cycle_end}::date
          ) as found`.execute(trx);
        return rows[0]?.found === true;
      }
      case 'exercise_performed': {
        const { rows } = await sql<{ found: boolean }>`
          select exists (
            select 1 from exercise x
             where x.management_system_id = ${ms} and x.deleted_at is null
               and x.performed_at between ${item.cycle_start}::date and ${item.cycle_end}::date
          ) as found`.execute(trx);
        return rows[0]?.found === true;
      }
    }
  }
}
