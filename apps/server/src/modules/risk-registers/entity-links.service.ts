// Links of shareable records to management systems (D.3 "Registers and workflows: risk side", A-29, TS 3.5, WP-36):
// linking a record of another system to the path system (feature `integrated_mode`), moving the primary system and
// removing a link. Every shareable record keeps exactly one primary link: the partial unique index allows at most
// one, the deferred constraint trigger requires one at commit, and these commands never leave a record without it.
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, EntityLinkRequest, ReasonBody, RecordModule, ShareableEntityType } from '@mscd/shared';
import { sql } from 'kysely';
import { ConflictError, NotFoundError } from '../../common/problems';
import {
  AUDIT_WRITER, LICENCE_GATE, RECORD_RESOLVER, type AuditWriter, type LicenceGate, type MsRef, type Principal, type RecordResolver, type Trx,
} from '../../common/tokens';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { commandResult, linksOf, orgOf, refOf, unprocessable } from './support';

/** Business id column of each shareable table; `audit_event` has none and cannot be linked by code. */
const CODE_COLUMNS: Readonly<Partial<Record<ShareableEntityType, string>>> = {
  context_issue: 'code',
  interested_party: 'code',
  asset: 'code',
  risk: 'code',
  metric: 'code',
  document: 'doc_code',
  evidence: 'evidence_code',
  management_review: 'code',
};

/** Module of a record ref by table (ARCHITECTURE 13), as the read model names them. */
function moduleOf(entityType: string): RecordModule {
  if (entityType === 'document') return 'implementation';
  if (entityType === 'evidence') return 'surveillance';
  return 'audit';
}

interface LinkRecord {
  id: string;
  entity_type: ShareableEntityType;
  entity_id: string;
  management_system_id: string;
  is_primary: boolean;
}

@Injectable()
export class EntityLinksService {
  constructor(
    private readonly tenancy: TenantScope,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/entity-links
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, ms: string, body: EntityLinkRequest): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const column = CODE_COLUMNS[body.entityType];
      if (!column) {
        throw unprocessable('entity_link.not_by_code', `Records of type ${body.entityType} cannot be linked by code`,
          `Catatan bertipe ${body.entityType} tidak dapat ditautkan dengan kode`);
      }
      const { rows } = await sql<{ id: string; updated_at: Date }>`
        select id, updated_at from ${sql.table(body.entityType)} where ${sql.ref(column)} = ${body.entityCode} and deleted_at is null for update`.execute(trx);
      const entity = rows[0];
      if (!entity) throw new NotFoundError(`No ${body.entityType} ${body.entityCode}`);
      const links = await linksOf(trx, body.entityType, entity.id);
      if (links.some((l) => l.msId === system.id)) {
        throw new ConflictError(`${body.entityCode} is already linked to ${system.slug}`, { messageKey: 'entity_link.duplicate' });
      }
      // TS 3.5: a record shared by a second system is the Integrated Management System feature.
      await this.licence.assertFeature(org.id, 'integrated_mode', trx);
      const primary = body.isPrimary === true || links.length === 0;
      if (primary) {
        await sql`update entity_ms_link set is_primary = false, updated_at = now(), updated_by = ${actor}
                   where entity_type = ${body.entityType} and entity_id = ${entity.id} and is_primary and deleted_at is null`.execute(trx);
      }
      const inserted = await trx
        .insertInto('entity_ms_link')
        .values({
          entity_type: body.entityType, entity_id: entity.id, management_system_id: system.id, is_primary: primary,
          relevance_note: body.relevanceNote ?? null, created_by: actor, updated_by: actor,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        action: 'entity_link.created',
        msId: system.id,
        entityType: body.entityType,
        entityId: entity.id,
        entityCode: body.entityCode,
        before: { linked_ms: links.map((l) => l.slug), primary: links.find((l) => l.isPrimary)?.slug ?? null },
        after: {
          linked_ms: [...links.map((l) => l.slug), system.slug],
          primary: primary ? system.slug : (links.find((l) => l.isPrimary)?.slug ?? null),
          ...(body.relevanceNote ? { relevance_note: body.relevanceNote } : {}),
        },
      });
      return commandResult([...links.map((l) => l.slug), system.slug], {
        ref: refOf(moduleOf(body.entityType), body.entityType, entity.id, body.entityCode, new Date(entity.updated_at)),
        data: { linkId: inserted.id },
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/entity-links/{id}/make-primary
  // -------------------------------------------------------------------------------------------------------------

  async makePrimary(principal: Principal, ms: string, id: string, body: ReasonBody): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const link = await this.linkOf(trx, system, id);
      const links = await linksOf(trx, link.entity_type, link.entity_id);
      const code = await this.codeOf(trx, link);
      const target = links.find((l) => l.id === link.id)!;
      const current = links.find((l) => l.isPrimary);
      if (link.is_primary) {
        return commandResult([], { message: [`${target.slug} is already the primary system`, `${target.slug} sudah menjadi sistem utama`] });
      }
      await sql`update entity_ms_link set is_primary = false, updated_at = now(), updated_by = ${actor}
                 where entity_type = ${link.entity_type} and entity_id = ${link.entity_id} and is_primary and deleted_at is null`.execute(trx);
      await sql`update entity_ms_link set is_primary = true, updated_at = now(), updated_by = ${actor} where id = ${link.id}`.execute(trx);
      await this.audit.record(trx, {
        action: 'register.updated',
        msId: system.id,
        entityType: link.entity_type,
        entityId: link.entity_id,
        entityCode: code,
        before: { primary: current?.slug ?? null },
        after: { primary: target.slug, ...(body.reason ? { reason: body.reason } : {}) },
      });
      return commandResult(links.map((l) => l.slug));
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/entity-links/{id}/remove
  // -------------------------------------------------------------------------------------------------------------

  async remove(principal: Principal, ms: string, id: string, body: ReasonBody): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const link = await this.linkOf(trx, system, id);
      const links = await linksOf(trx, link.entity_type, link.entity_id);
      const target = links.find((l) => l.id === link.id)!;
      if (link.is_primary) {
        throw unprocessable('entity_link.primary', 'The primary link cannot be removed; make another system primary first (A-29)',
          'Tautan utama tidak dapat dihapus; jadikan sistem lain sebagai utama terlebih dahulu (A-29)');
      }
      if (link.entity_type === 'evidence') {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from evidence_target
           where evidence_id = ${link.entity_id} and management_system_id = ${link.management_system_id} and deleted_at is null`.execute(trx);
        if ((rows[0]?.n ?? 0) > 0) {
          throw unprocessable('entity_link.evidence_targets', `The evidence still targets entries of ${target.slug}; remove those targets first`,
            `Bukti masih menargetkan entri ${target.slug}; hapus target tersebut terlebih dahulu`);
        }
      }
      const code = await this.codeOf(trx, link);
      await sql`update entity_ms_link set deleted_at = now(), updated_at = now(), updated_by = ${actor} where id = ${link.id}`.execute(trx);
      await this.audit.record(trx, {
        action: 'entity_link.removed',
        msId: system.id,
        entityType: link.entity_type,
        entityId: link.entity_id,
        entityCode: code,
        before: { linked_ms: links.map((l) => l.slug) },
        after: { linked_ms: links.filter((l) => l.id !== link.id).map((l) => l.slug), ...(body.reason ? { reason: body.reason } : {}) },
      });
      return commandResult(links.map((l) => l.slug));
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** A live link whose record is linked to the path system; 404 otherwise (F.7: nothing of other systems leaks). */
  private async linkOf(trx: Trx, system: MsRef, id: string): Promise<LinkRecord> {
    const { rows } = await sql<LinkRecord>`
      select l.id, l.entity_type, l.entity_id, l.management_system_id, l.is_primary from entity_ms_link l
       where l.id = ${id} and l.deleted_at is null
         and exists (select 1 from entity_ms_link p where p.entity_type = l.entity_type and p.entity_id = l.entity_id
                       and p.management_system_id = ${system.id} and p.deleted_at is null)
       for update`.execute(trx);
    const link = rows[0];
    if (!link) throw new NotFoundError();
    return link;
  }

  private async codeOf(trx: Trx, link: LinkRecord): Promise<string | null> {
    const column = CODE_COLUMNS[link.entity_type];
    if (!column) return null;
    const { rows } = await sql<{ code: string }>`select ${sql.ref(column)} as code from ${sql.table(link.entity_type)} where id = ${link.entity_id}`.execute(trx);
    return rows[0]?.code ?? null;
  }
}
