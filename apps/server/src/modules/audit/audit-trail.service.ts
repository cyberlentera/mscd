// Reading the audit trail (build plan D.3 `/admin/audit-trail`, F.11): MS Managers and time-boxed external auditors
// read full entries of their system (`audit_trail.read` in `ms`); Tenant Admins read metadata only
// (`audit_trail.metadata.read`), because before and after values are business data. The metadata view of the
// whole organisation also lists the organisation's rows of `platform.audit_log` (sign-ins, users, licences).
// Rows of another organisation are never visible: tenant rows live in the organisation's schema and both tables
// carry RLS on `app.org_id`.
import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import type { AuditEntry, AuditEntryMeta, AuditTrailQuery } from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import { addDays, startOfLocalDay } from '../../common/dates';
import { NotFoundError } from '../../common/problems';
import { createSafeCsvStream } from '../../common/spreadsheet-safe';
import type { Principal, TenantInfo, Trx } from '../../common/tokens';
import { TenantScope, tenantContextOf, type TenantContext } from '../tenancy/tenant-scope';
import { PLATFORM_CHAIN, tenantChainName } from './chain-verifier';
import { signedAnchorOf, type AnchorRow, type SignedAnchor } from './anchors';

/** `Page<T>` of D.2. */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

interface EntryRow {
  seq: string;
  occurred_at: Date;
  actor_kind: 'user' | 'system' | 'guest' | 'operator';
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_code: string | null;
  before_data: unknown;
  after_data: unknown;
  edition: string | null;
  request_id: string | null;
  source_ip: string | null;
  user_agent: string | null;
  handle: string | null;
  display_name: string | null;
  ms_slug: string | null;
}

export interface TrailFilter {
  msId?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  /** Also list the organisation's `platform.audit_log` rows (metadata view of the whole organisation). */
  includePlatform: boolean;
  /** Only entries after this `seq` (keyset paging of the export). */
  afterSeq?: string;
}

/** Columns of the CSV export, in order. */
export const AUDIT_CSV_COLUMNS = [
  'seq', 'occurred_at', 'actor', 'actor_name', 'actor_kind', 'action', 'entity_type', 'entity_id', 'entity_code', 'ms',
  'before', 'after', 'edition', 'request_id', 'source_ip', 'user_agent',
] as const;

const EXPORT_BATCH = 1000;

@Injectable()
export class AuditTrailService {
  constructor(private readonly scope: TenantScope) {}

  /** `management_system.id` of a slug in the transaction's organisation; 404 when unknown. */
  async msIdOf(trx: Trx, slug: string): Promise<string> {
    const row = await trx.selectFrom('management_system').select('id').where('slug', '=', slug).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw new NotFoundError('Unknown management system');
    return row.id;
  }

  /** One page of entries, full (`full: true`) or metadata only. */
  async list(principal: Principal, query: AuditTrailQuery, full: boolean): Promise<Page<AuditEntry> | Page<AuditEntryMeta>> {
    const org = this.orgOf(principal);
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const msId = query.ms ? await this.msIdOf(trx, query.ms) : undefined;
      const filter: TrailFilter = {
        msId,
        entityType: query.entityType,
        entityId: query.entityId,
        from: query.from,
        to: query.to,
        includePlatform: !full && !query.ms,
      };
      const entries = this.entriesSql(filter, org);
      const totalRow = await sql<{ total: string }>`select count(*) as total from (${entries}) e`.execute(trx);
      const offset = (query.page - 1) * query.pageSize;
      const { rows } = await sql<EntryRow>`
        select e.*, u.handle, u.display_name, ms.slug as ms_slug
        from (${entries}) e
        left join platform.app_user u on u.id = e.actor_user_id
        left join management_system ms on ms.id = e.management_system_id
        order by e.occurred_at desc, e.seq desc, e.chain
        limit ${query.pageSize} offset ${offset}`.execute(trx);
      const items = rows.map((row) => (full ? this.toEntry(row) : this.toMeta(row)));
      return { items, page: query.page, pageSize: query.pageSize, total: Number(totalRow.rows[0]?.total ?? 0) } as Page<AuditEntry> | Page<AuditEntryMeta>;
    });
  }

  /** Every entry of one system, oldest first, as formula-safe CSV (F.15), read in batches. */
  exportCsv(principal: Principal, ms: string): Readable {
    const org = this.orgOf(principal);
    const csv = createSafeCsvStream(AUDIT_CSV_COLUMNS);
    const source = Readable.from(this.exportRows(tenantContextOf(principal), org, ms));
    source.on('error', (error) => csv.destroy(error));
    return source.pipe(csv);
  }

  /** CSV rows of a system's entries, read in batches of `EXPORT_BATCH` by `seq`, each batch in its own transaction. */
  private async *exportRows(context: TenantContext, org: TenantInfo, ms: string): AsyncGenerator<unknown[]> {
    const msId = await this.scope.withTenant(context, (trx) => this.msIdOf(trx, ms));
    let afterSeq = '0';
    for (;;) {
      const batch = await this.scope.withTenant(context, async (trx) => {
        const entries = this.entriesSql({ msId, includePlatform: false, afterSeq }, org);
        const result = await sql<EntryRow>`
          select e.*, u.handle, u.display_name, ms.slug as ms_slug
          from (${entries}) e
          left join platform.app_user u on u.id = e.actor_user_id
          left join management_system ms on ms.id = e.management_system_id
          order by e.seq asc limit ${EXPORT_BATCH}`.execute(trx);
        return result.rows;
      });
      for (const row of batch) {
        yield [
          Number(row.seq), row.occurred_at, row.handle, row.display_name, row.actor_kind, row.action, row.entity_type, row.entity_id,
          row.entity_code, row.ms_slug, row.before_data ?? null, row.after_data ?? null, row.edition, row.request_id, row.source_ip,
          row.user_agent,
        ];
      }
      if (batch.length < EXPORT_BATCH) return;
      afterSeq = batch[batch.length - 1]!.seq;
    }
  }

  /** Signed anchors of the organisation's chain and of the platform chain, between two local dates. */
  async anchors(principal: Principal, from?: string, to?: string): Promise<SignedAnchor[]> {
    const org = this.orgOf(principal);
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      let query = trx
        .selectFrom('platform.audit_anchor')
        .select(['chain', 'seq', 'row_hash', 'payload', 'signature', 'key_id', 'anchored_at'])
        .where('chain', 'in', [tenantChainName(org.schema), PLATFORM_CHAIN]);
      if (from) query = query.where('anchored_at', '>=', startOfLocalDay(from, org.timeZone));
      if (to) query = query.where('anchored_at', '<', startOfLocalDay(addDays(to, 1), org.timeZone));
      const rows = await query.orderBy('anchored_at', 'asc').orderBy('chain').execute();
      return rows.map((row) => signedAnchorOf(row as AnchorRow)).filter((a): a is SignedAnchor => a !== null);
    });
  }

  private orgOf(principal: Principal): TenantInfo {
    if (!principal.org) throw new NotFoundError('No current organisation');
    return principal.org;
  }

  /** Union of the entries the filter selects, with the columns the readers need. */
  private entriesSql(filter: TrailFilter, org: TenantInfo): RawBuilder<unknown> {
    const conditions = (alias: 't' | 'p'): RawBuilder<unknown> => {
      const a = sql.raw(alias);
      const parts: RawBuilder<unknown>[] = [sql`true`];
      if (filter.msId) parts.push(sql`${a}.management_system_id = ${filter.msId}`);
      if (filter.entityType) parts.push(sql`${a}.entity_type = ${filter.entityType}`);
      if (filter.entityId) parts.push(sql`${a}.entity_id = ${filter.entityId}`);
      if (filter.from) parts.push(sql`${a}.occurred_at >= ${startOfLocalDay(filter.from, org.timeZone)}`);
      if (filter.to) parts.push(sql`${a}.occurred_at < ${startOfLocalDay(addDays(filter.to, 1), org.timeZone)}`);
      if (filter.afterSeq) parts.push(sql`${a}.seq > ${filter.afterSeq}`);
      return sql.join(parts, sql` and `);
    };
    const columns = (alias: 't' | 'p', chain: string) => {
      const a = sql.raw(alias);
      return sql`${sql.lit(chain)} as chain, ${a}.seq, ${a}.occurred_at, ${a}.actor_user_id, ${a}.actor_kind, ${a}.action,
        ${a}.entity_type, ${a}.entity_id, ${a}.entity_code, ${a}.management_system_id, ${a}.before_data, ${a}.after_data,
        ${a}.edition, ${a}.request_id, host(${a}.source_ip) as source_ip, ${a}.user_agent`;
    };
    const tenant = sql`select ${columns('t', 'tenant')} from audit_trail t where ${conditions('t')}`;
    if (!filter.includePlatform) return tenant;
    return sql`${tenant} union all
      select ${columns('p', 'platform')} from platform.audit_log p where p.organization_id = ${org.id} and ${conditions('p')}`;
  }

  private toMeta(row: EntryRow): AuditEntryMeta {
    return {
      seq: Number(row.seq),
      occurredAt: row.occurred_at.toISOString(),
      actor: { handle: row.handle, displayName: row.display_name, kind: row.actor_kind },
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      ms: row.ms_slug,
      edition: row.edition,
      requestId: row.request_id,
      sourceIp: row.source_ip,
      userAgent: row.user_agent,
    };
  }

  private toEntry(row: EntryRow): AuditEntry {
    return {
      ...this.toMeta(row),
      entityCode: row.entity_code,
      ...(row.before_data !== null && row.before_data !== undefined ? { before: row.before_data } : {}),
      ...(row.after_data !== null && row.after_data !== undefined ? { after: row.after_data } : {}),
    };
  }
}
