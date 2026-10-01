// Document register commands of D.3 (WP-35, C.13 `document.status`, A.4 5.7 and 5.8): register a controlled
// document (doc_type from the edition's lookups, linked systems through `entity_ms_link`), change its fields (BR-22
// confirmation for shared documents), and move it through review: start a review (draft or expired), approve it
// (never by the author of the version in review, BR-16) or return it to draft with a note. Approval makes the version
// in review the current one, supersedes the earlier approved version and ends the review (WP-21 follow-up).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, DocumentCreateRequest, DocumentPatch, DocumentTransitionRequest } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { addDays } from '../../common/dates';
import { assertIfMatch } from '../../common/etag';
import { ConflictError, ForbiddenError } from '../../common/problems';
import {
  AUDIT_WRITER, LICENCE_GATE, MEMBERSHIP_SERVICE, PERMISSION_EVALUATOR, RECORD_RESOLVER, type AuditWriter, type AuthzState, type LicenceGate,
  type MembershipService, type PermissionEvaluator, type Principal, type RecordResolver, type Trx,
} from '../../common/tokens';
import { RuleEngine } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { assertRequires, commandResult, linkedSystems, orgOf, personOf, pickTransition, refOf, todayOf, unprocessable, writeRow } from './command-support';
import type { Br16Input } from './register.rules';
import { SharedChangeGuard } from './shared-change';

const ENTITY = 'document';
const MACHINE = 'document.status' as const;

interface DocumentRow {
  id: string;
  updated_at: Date;
  created_by: string | null;
  doc_code: string;
  title: string;
  status: 'draft' | 'in_review' | 'approved' | 'expired';
  classification: string;
  owner_user_id: string | null;
  approver_user_id: string | null;
  current_version_id: string | null;
  approved_at: string | null;
  next_review_at: string | null;
  is_org_wide: boolean;
  pending_holder_user_id: string | null;
  pending_due_at: string | null;
  review_started_at: string | null;
}

interface VersionRow {
  id: string;
  version_label: string;
  status: string;
  submitted_by: string | null;
}

@Injectable()
export class DocumentCommandsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly rules: RuleEngine,
    private readonly shared: SharedChangeGuard,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/documents/{id}/transitions
  // -------------------------------------------------------------------------------------------------------------

  async transition(principal: Principal, authz: AuthzState | null, ms: string, id: string, body: DocumentTransitionRequest, ifMatch: string | undefined): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const doc = record.row as unknown as DocumentRow;
      const currentRef = refOf(ENTITY, id, doc.doc_code, doc.updated_at);
      assertIfMatch(ifMatch, doc.updated_at, currentRef);
      const from = doc.status;
      const to = body.to;
      const transition = pickTransition(MACHINE, from, to, authz, doc.owner_user_id === actor);
      assertRequires(transition, body as Record<string, unknown>);
      const today = todayOf(this.clock, org);
      const systems = await linkedSystems(trx, ENTITY, id, record.ms.id);
      const msIds = systems.length > 0 ? systems.map((s) => s.id) : [record.ms.id];
      const inReview = await this.versionInReview(trx, id);
      const set: Record<string, unknown> = { status: to };
      const before: Record<string, unknown> = { status: from };
      const after: Record<string, unknown> = { status: to };

      if (to === 'in_review') {
        set.review_started_at = today;
        after.review_started_at = today;
      } else if (to === 'approved') {
        // BR-16: the author of what is approved never approves it (the version in review, else the version in
        // force; a register entry without any version: its creator).
        const current = inReview ?? (doc.current_version_id ? await this.version(trx, doc.current_version_id) : null);
        const authors = current ? [current.submitted_by] : [doc.created_by];
        await this.rules.enforce<Br16Input>(trx, 'BR-16', { actorId: actor, authors }, { msIds, ref: currentRef });
        if (inReview) {
          await sql`update document_version set status = 'superseded', updated_at = now(), updated_by = ${actor}
                     where document_id = ${id} and status = 'approved' and id <> ${inReview.id} and deleted_at is null`.execute(trx);
          await sql`update document_version set status = 'approved', approved_by = ${actor}, approved_at = ${today}::date, updated_at = now(),
                     updated_by = ${actor} where id = ${inReview.id}`.execute(trx);
          set.current_version_id = inReview.id;
          before.current_version = doc.current_version_id ? (await this.version(trx, doc.current_version_id))?.version_label ?? null : null;
          after.current_version = inReview.version_label;
        }
        set.approved_at = today;
        // A review confirmed on or after the review date moves the next review a year ahead (BR-10 would expire it again).
        if (!doc.next_review_at || doc.next_review_at <= today) {
          set.next_review_at = addDays(today, 365);
          after.next_review_at = set.next_review_at;
        }
        Object.assign(set, { review_started_at: null, pending_holder_user_id: null, pending_due_at: null });
        after.approved_at = today;
      } else {
        // Rejection (in review to draft): the version in review is rejected with the note; the version in force stays.
        if (inReview) {
          await sql`update document_version set status = 'rejected', rejection_note = ${body.note!}, updated_at = now(), updated_by = ${actor}
                     where id = ${inReview.id}`.execute(trx);
          after.rejected_version = inReview.version_label;
        }
        set.review_started_at = null;
      }
      if (body.note) after.note = body.note;
      const updatedAt = await writeRow(trx, ENTITY, id, set, actor);
      await this.audit.record(trx, { action: 'document.transition', msId: record.ms.id, entityType: ENTITY, entityId: id, entityCode: doc.doc_code, before, after });
      return commandResult(systems.length > 0 ? systems.map((s) => s.slug) : [record.ms.slug], { ref: refOf(ENTITY, id, doc.doc_code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/documents
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, ms: string, body: DocumentCreateRequest): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const slugs = [...new Set(body.linkedMs)];
      if (!slugs.includes(system.slug)) {
        throw unprocessable('documents.path_system_not_linked', `linkedMs must include ${system.slug}`, `linkedMs harus memuat ${system.slug}`);
      }
      // The path system first: it holds the primary link (A-29).
      const ordered = [system.slug, ...slugs.filter((s) => s !== system.slug)];
      const systems = [];
      for (const slug of ordered) systems.push(await this.records.resolveMs(trx, slug));
      for (const other of systems.slice(1)) {
        if ((await this.evaluator.evaluate(principal, 'document.manage', { scope: 'ms', ms: other.slug })) !== 'full') {
          throw new ForbiddenError(`Linking a document to ${other.slug} needs document.manage there`);
        }
      }
      if (systems.length > 1) await this.licence.assertFeature(org.id, 'integrated_mode', trx);
      await this.assertDocType(trx, system.id, body.docType);
      const duplicate = await sql<{ id: string }>`select id from document where doc_code = ${body.docCode} and deleted_at is null limit 1`.execute(trx);
      if (duplicate.rows.length > 0) throw new ConflictError(`Document ${body.docCode} already exists`, { messageKey: 'documents.duplicate_code' });
      const owner = await this.members.resolveHandle(trx, body.ownerHandle);
      const approver = body.approverHandle ? await this.members.resolveHandle(trx, body.approverHandle) : null;
      const id = randomUUID();
      const position = await sql<{ next: number }>`select coalesce(max(position), -1)::int + 1 as next from document`.execute(trx);
      const { rows } = await sql<{ updated_at: Date }>`
        insert into document (id, doc_code, title, doc_type, status, classification, owner_user_id, approver_user_id, next_review_at,
                              is_org_wide, position, created_by, updated_by)
        values (${id}, ${body.docCode}, ${body.title}, ${body.docType}, 'draft', ${body.classification}, ${owner}, ${approver},
                ${body.nextReviewAt ?? null}::date, ${body.orgWide}, ${position.rows[0]?.next ?? 0}, ${actor}, ${actor})
        returning updated_at`.execute(trx);
      for (const [i, s] of systems.entries()) {
        await sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary, created_by, updated_by)
                  values ('document', ${id}, ${s.id}, ${i === 0}, ${actor}, ${actor})`.execute(trx);
      }
      await this.audit.record(trx, {
        action: 'document.created',
        msId: system.id,
        entityType: ENTITY,
        entityId: id,
        entityCode: body.docCode,
        after: {
          title: body.title,
          doc_type: body.docType,
          status: 'draft',
          classification: body.classification,
          owner: body.ownerHandle,
          ...(body.approverHandle ? { approver: body.approverHandle } : {}),
          ...(body.nextReviewAt ? { next_review_at: body.nextReviewAt } : {}),
          is_org_wide: body.orgWide,
          systems: systems.map((s) => s.slug),
        },
      });
      return commandResult(systems.map((s) => s.slug), { ref: refOf(ENTITY, id, body.docCode, rows[0]!.updated_at) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/documents/{id}
  // -------------------------------------------------------------------------------------------------------------

  async update(principal: Principal, ms: string, id: string, patch: DocumentPatch, ifMatch: string | undefined): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const doc = record.row as unknown as DocumentRow;
      const currentRef = refOf(ENTITY, id, doc.doc_code, doc.updated_at);
      assertIfMatch(ifMatch, doc.updated_at, currentRef);
      // BR-22: the change applies to every linked system.
      const systems = await this.shared.assertConfirmed(trx, { entityType: ENTITY, id, msId: record.ms.id, ref: currentRef }, patch.confirm);
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: keyof DocumentRow, value: unknown, shown: { before?: unknown; after?: unknown } = {}) => {
        if ((doc[column] ?? null) === (value ?? null)) return;
        set[column] = value ?? null;
        before[column] = shown.before !== undefined ? shown.before : (doc[column] ?? null);
        after[column] = shown.after !== undefined ? shown.after : (value ?? null);
      };
      if (patch.title !== undefined) change('title', patch.title);
      if (patch.classification !== undefined) change('classification', patch.classification);
      if (patch.nextReviewAt !== undefined) change('next_review_at', patch.nextReviewAt);
      if (patch.ownerHandle !== undefined) {
        const owner = await this.members.resolveHandle(trx, patch.ownerHandle);
        change('owner_user_id', owner, { before: (await personOf(trx, doc.owner_user_id))?.handle ?? 'none', after: patch.ownerHandle });
      }
      if (patch.approverHandle !== undefined) {
        const approver = patch.approverHandle === null ? null : await this.members.resolveHandle(trx, patch.approverHandle);
        change('approver_user_id', approver, { before: (await personOf(trx, doc.approver_user_id))?.handle ?? null, after: patch.approverHandle });
      }
      const updatedAt = await writeRow(trx, ENTITY, id, set, actor);
      if (Object.keys(after).length > 0) {
        await this.audit.record(trx, {
          action: 'document.updated',
          msId: record.ms.id,
          entityType: ENTITY,
          entityId: id,
          entityCode: doc.doc_code,
          before,
          after: { ...after, ...(systems.length > 1 ? { systems: systems.map((s) => s.slug) } : {}) },
        });
      }
      return commandResult(systems.length > 0 ? systems.map((s) => s.slug) : [record.ms.slug], { ref: refOf(ENTITY, id, doc.doc_code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** 422 unless `docType` is a `doc_type` lookup of the system's edition (`ref.lookup_value`). */
  private async assertDocType(trx: Trx, msId: string, docType: string): Promise<void> {
    const { rows } = await sql<{ code: string }>`
      select l.code from ref.lookup_value l join management_system m on m.framework_version_id = l.framework_version_id
       where m.id = ${msId} and l.domain = 'doc_type' and l.code = ${docType}`.execute(trx);
    if (rows.length === 0) {
      throw unprocessable('documents.unknown_doc_type', `${docType} is not a document type of the edition in use`, `${docType} bukan jenis dokumen dari edisi yang digunakan`);
    }
  }

  private async versionInReview(trx: Trx, documentId: string): Promise<VersionRow | null> {
    const { rows } = await sql<VersionRow>`
      select id, version_label, status, submitted_by from document_version
       where document_id = ${documentId} and status = 'in_review' and deleted_at is null
       order by created_at desc limit 1 for update`.execute(trx);
    return rows[0] ?? null;
  }

  private async version(trx: Trx, versionId: string): Promise<VersionRow | null> {
    const { rows } = await sql<VersionRow>`select id, version_label, status, submitted_by from document_version where id = ${versionId}`.execute(trx);
    return rows[0] ?? null;
  }
}
