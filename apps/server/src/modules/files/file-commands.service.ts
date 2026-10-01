// Evidence files and document versions (build plan D.3, A.4 5.7, E.3, BR-23, BR-29, BR-30, BR-36): a linked
// provider item (gateway `link`, the current version pinned) or a finished upload intent becomes the evidence's file
// or a new document version in review. The evidence's freshness and integrity are stored in the same transaction
// and `freshness.recompute` is queued for its target systems.
import { Inject, Injectable } from '@nestjs/common';
import {
  type CommandResult,
  type DocumentVersionRequest,
  type EvidenceFileRequest,
  type GatewayRepository,
  type GatewayTenant,
  type ObjectMetadata,
  type PinVersionResult,
  type ScopeRoot,
  type UploadMode,
} from '@mscd/shared';
import { sql } from 'kysely';
import { addDays, localDate } from '../../common/dates';
import { etagOf } from '../../common/etag';
import { ConflictError } from '../../common/problems';
import {
  AUDIT_WRITER,
  GATEWAY_CLIENT,
  JOB_QUEUE,
  type AuditWriter,
  type GatewayClient,
  type JobQueue,
  type Principal,
  type ResolvedRecord,
  type Trx,
} from '../../common/tokens';
import type { RepositoryRow } from '../storage';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { deriveEvidence } from './evidence-state';
import { FilesCommon, recordRef, type FilesMs } from './files-common';
import {
  assertRepositoryUsable,
  documentVersionLabel,
  nextDocumentVersion,
  refusal,
  scopeRootOf,
  viaGateway,
  warning,
  type Warning,
} from './files-support';
import { insertProviderObject, providerObjectRef, type NewObject } from './storage-objects';

/** E.2: producers debounce `freshness.recompute` by 5 seconds; one waiting job per organisation and system. */
const FRESHNESS_DELAY_SECONDS = 5;

/** Link states that need no relink (valid and verified). */
const LINK_OK = new Set(['intact', 'moved']);

interface LinkSource {
  kind: 'link';
  repository: RepositoryRow;
  tenant: GatewayTenant;
  descriptor: GatewayRepository;
  scopeRoot: ScopeRoot;
  externalItemId: string;
}

interface IntentSource {
  kind: 'intent';
  intentId: string;
  storageObjectId: string;
  mode: UploadMode;
  repository: RepositoryRow;
}

/** `upload_intent` facts of an attach. */
interface AttachIntent {
  id: string;
  status: string;
  mode: UploadMode;
  object_kind: string;
  target_id: string;
  management_system_id: string;
  storage_object_id: string | null;
  storage_repository_id: string;
}

@Injectable()
export class FileCommandsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly common: FilesCommon,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/evidence/{id}/files
  // ---------------------------------------------------------------------------------------------------------------

  async evidenceFile(principal: Principal, msSlug: string, id: string, body: EvidenceFileRequest, own: boolean): Promise<CommandResult> {
    const org = this.common.org(principal);
    const today = this.common.today(principal);
    const producedAt = body.producedAt ?? today;
    if (producedAt > today) {
      throw refusal('files.produced_in_future', {
        en: 'The evidence date cannot be later than today.',
        id: 'Tanggal bukti tidak boleh lebih lambat dari hari ini.',
      });
    }
    const prepared = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const ms = await this.common.ms(trx, msSlug);
      const record = await this.common.record(trx, principal, msSlug, 'evidence', id, own);
      if (body.mode === 'relink') await this.assertRelinkable(trx, record);
      const source =
        body.source === 'link'
          ? await this.linkSource(trx, org.id, ms, body.repository, body.externalItemId)
          : await this.intentSource(trx, principal, ms, 'evidence', record.id, body.uploadIntentId, body.source === 'client_upload' ? ['zero_transit'] : ['stored', 'pass_through']);
      return { ms, source };
    });
    const metadata = prepared.source.kind === 'link' ? await this.link(prepared.source) : null;
    // Pinned before the transaction, so no record lock is held across the gateway call.
    if (prepared.source.kind === 'link' && prepared.source.repository.adapter === 'google_drive') await this.pin(prepared.source, metadata!);

    const now = this.common.clock.now();
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const { ms, source } = prepared;
      const record = await this.common.record(trx, principal, msSlug, 'evidence', id, own, { forUpdate: true });
      const row = record.row as {
        evidence_code: string; produced_at: string | null; storage_object_id: string | null; file_sequence: number; frequency_code: string; updated_at: Date;
      };
      if (body.mode === 'relink') await this.assertRelinkable(trx, record);
      if (source.kind === 'intent') await this.lockIntent(trx, source.intentId);
      const object: NewObject =
        source.kind === 'link'
          ? await insertProviderObject(trx, { repository: source.repository, metadata: metadata!, userId: principal.user.id, now })
          : await this.objectOfIntent(trx, source.storageObjectId);
      const sequence = body.mode === 'relink' ? Math.max(row.file_sequence, 1) : row.file_sequence + 1;
      if (source.repository.adapter === 'managed_vault') {
        // D-10 vault objects are immutable; their label is the evidence's file sequence (WP-13 handoff deviation 3).
        await trx.updateTable('storage_object').set({ version_label: `v${sequence}`, updated_at: now }).where('id', '=', object.id).execute();
        object.versionLabel = `v${sequence}`;
      }
      const stored = await trx
        .selectFrom('storage_object')
        .select(['link_status', 'hash_algorithm', 'hash_source', 'link_status_since', 'link_status_reason'])
        .where('id', '=', object.id)
        .executeTakeFirstOrThrow();
      const derived = await deriveEvidence(trx, {
        evidenceId: record.id,
        frequencyCode: row.frequency_code,
        producedAt,
        object: {
          linkStatus: stored.link_status,
          hashAlgorithm: stored.hash_algorithm,
          hashSource: stored.hash_source,
          linkStatusSince: stored.link_status_since,
          linkStatusReason: stored.link_status_reason,
        },
        today,
        now,
      });
      const updated = await trx
        .updateTable('evidence')
        .set({
          storage_object_id: object.id,
          produced_at: producedAt,
          file_sequence: sequence,
          freshness_status: derived.freshness,
          integrity_status: derived.integrity,
          derived_at: now,
          updated_at: now,
          updated_by: principal.user.id,
        })
        .where('id', '=', record.id)
        .returning(['updated_at'])
        .executeTakeFirstOrThrow();
      if (source.kind === 'intent') await this.completeIntent(trx, source.intentId, principal.user.id, now);

      const warnings: Warning[] = [];
      if (source.repository.ownership_type === 'personal') warnings.push(warning('BR-30'));
      if (object.providerCreatedAt && producedAt > addDays(localDate(object.providerCreatedAt, org.timeZone), 1)) warnings.push(warning('BR-36'));
      if (await this.crossSystemNonReusable(trx, record.id)) warnings.push(warning('BR-23'));

      const systems = await this.common.evidenceSystems(trx, record.id);
      await this.audit.record(trx, {
        action: source.kind === 'link' ? 'evidence.file_linked' : 'evidence.file_uploaded',
        msId: ms.id,
        entityType: 'evidence',
        entityId: record.id,
        entityCode: row.evidence_code,
        before: { producedAt: row.produced_at, storageObjectId: row.storage_object_id, fileSequence: row.file_sequence },
        after: {
          producedAt,
          storageObjectId: object.id,
          fileSequence: sequence,
          mode: body.mode,
          source: body.source,
          repository: source.repository.slug,
          versionLabel: object.versionLabel,
          hashAlgorithm: object.hashAlgorithm,
        },
      });
      for (const msId of systems.ids) {
        await this.jobs.send(
          'freshness.recompute',
          { orgId: org.id, requestedBy: principal.user.id, payload: { msId } },
          { singletonKey: `fr:${org.id}:${msId}`, startAfterSeconds: FRESHNESS_DELAY_SECONDS, retryLimit: 3 },
          trx,
        );
      }
      return {
        ok: true,
        changed: systems.slugs,
        ...(warnings.length > 0 ? { warnings } : {}),
        ref: { ...recordRef('evidence', record.id, row.evidence_code), etag: etagOf(updated.updated_at) },
        data: { storageObjectId: object.id, versionLabel: object.versionLabel, producedAt },
      };
    });
  }

  /** Relink replaces a file that cannot be verified (TS 5.3); an intact or moved file needs a new submission. */
  private async assertRelinkable(trx: Trx, record: ResolvedRecord): Promise<void> {
    const objectId = record.row.storage_object_id as string | null;
    if (!objectId) return;
    const object = await trx.selectFrom('storage_object').select('link_status').where('id', '=', objectId).executeTakeFirst();
    if (object && LINK_OK.has(object.link_status)) {
      throw new ConflictError('The current file is intact; submit a new file instead of relinking', { messageKey: 'files.relink_not_needed' });
    }
  }

  /** BR-23: the evidence also targets another system through a mapping with `evidence_reusable = false`. */
  private async crossSystemNonReusable(trx: Trx, evidenceId: string): Promise<boolean> {
    const { rows } = await sql<{ found: boolean }>`
      select exists (
        select 1
          from evidence_target a
          join evidence_target b on b.evidence_id = a.evidence_id and b.management_system_id <> a.management_system_id and b.deleted_at is null
          left join ref.catalogue_item ca on ca.id = a.catalogue_item_id
          left join ref.catalogue_item cb on cb.id = b.catalogue_item_id
          join ref.requirement_mapping m
            on (m.source_requirement_id = coalesce(a.requirement_id, ca.requirement_id) and m.target_requirement_id = coalesce(b.requirement_id, cb.requirement_id))
            or (m.target_requirement_id = coalesce(a.requirement_id, ca.requirement_id) and m.source_requirement_id = coalesce(b.requirement_id, cb.requirement_id))
         where a.evidence_id = ${evidenceId} and a.deleted_at is null and m.evidence_reusable = false
      ) as found`.execute(trx);
    return rows[0]?.found === true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/documents/{id}/versions
  // ---------------------------------------------------------------------------------------------------------------

  async documentVersion(principal: Principal, msSlug: string, id: string, body: DocumentVersionRequest, own: boolean): Promise<CommandResult> {
    const org = this.common.org(principal);
    const today = this.common.today(principal);
    const prepared = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const ms = await this.common.ms(trx, msSlug);
      const record = await this.common.record(trx, principal, msSlug, 'document', id, own);
      await this.assertNoReview(trx, record.id);
      const source =
        body.source === 'link'
          ? await this.linkSource(trx, org.id, ms, body.repository, body.externalItemId)
          : await this.intentSource(trx, principal, ms, 'document', record.id, body.uploadIntentId, ['stored', 'pass_through', 'zero_transit']);
      return { ms, source };
    });
    const metadata = prepared.source.kind === 'link' ? await this.link(prepared.source) : null;
    // Pinned before the transaction, so no record lock is held across the gateway call.
    if (prepared.source.kind === 'link' && prepared.source.repository.adapter === 'google_drive') await this.pin(prepared.source, metadata!);

    const now = this.common.clock.now();
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const { ms, source } = prepared;
      const record = await this.common.record(trx, principal, msSlug, 'document', id, own, { forUpdate: true });
      const row = record.row as { doc_code: string; status: string; is_org_wide: boolean; current_version_id: string | null; review_started_at: string | null };
      await this.assertNoReview(trx, record.id);
      if (source.kind === 'intent') await this.lockIntent(trx, source.intentId);
      const object: NewObject =
        source.kind === 'link'
          ? await insertProviderObject(trx, { repository: source.repository, metadata: metadata!, userId: principal.user.id, now })
          : await this.objectOfIntent(trx, source.storageObjectId);
      const existing = (
        await trx.selectFrom('document_version').select('version_label').where('document_id', '=', record.id).where('deleted_at', 'is', null).execute()
      ).map((v) => v.version_label);
      let label = source.kind === 'link' || source.repository.adapter !== 'managed_vault' ? documentVersionLabel(object.versionLabel) : null;
      if (label && existing.includes(label)) {
        throw new ConflictError(`Version ${label} of this document is already recorded`, { messageKey: 'files.version_exists' });
      }
      label ??= nextDocumentVersion(existing);
      // The vault object keeps its `v<file_sequence>` label; the major version is the document version's label only.
      const version = await trx
        .insertInto('document_version')
        .values({
          document_id: record.id,
          version_label: label,
          storage_object_id: object.id,
          status: 'in_review',
          submitted_by: principal.user.id,
          submitted_at: now,
          created_by: principal.user.id,
          updated_by: principal.user.id,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      const updated = await trx
        .updateTable('document')
        .set({ status: 'in_review', review_started_at: row.review_started_at ?? today, updated_at: now, updated_by: principal.user.id })
        .where('id', '=', record.id)
        .returning(['updated_at'])
        .executeTakeFirstOrThrow();
      if (source.kind === 'intent') await this.completeIntent(trx, source.intentId, principal.user.id, now);
      await this.audit.record(trx, {
        action: 'document.version_created',
        msId: ms.id,
        entityType: 'document',
        entityId: record.id,
        entityCode: row.doc_code,
        before: { status: row.status },
        after: {
          status: 'in_review',
          versionId: version.id,
          versionLabel: label,
          storageObjectId: object.id,
          source: body.source,
          repository: source.repository.slug,
          hashAlgorithm: object.hashAlgorithm,
        },
      });
      const warnings: Warning[] = source.repository.ownership_type === 'personal' ? [warning('BR-30')] : [];
      return {
        ok: true,
        changed: await this.common.documentSystems(trx, record.id, row.is_org_wide),
        message: [`${row.doc_code} v${label} submitted for review`, `${row.doc_code} v${label} diajukan untuk review`],
        ...(warnings.length > 0 ? { warnings } : {}),
        ref: { ...recordRef('document', record.id, row.doc_code), etag: etagOf(updated.updated_at) },
        data: { versionId: version.id, versionLabel: label, storageObjectId: object.id },
      };
    });
  }

  /** 409 while a version of the document waits for review (BR-16 needs one decision at a time). */
  private async assertNoReview(trx: Trx, documentId: string): Promise<void> {
    const pending = await trx
      .selectFrom('document_version')
      .select('version_label')
      .where('document_id', '=', documentId)
      .where('status', '=', 'in_review')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (pending) throw new ConflictError(`Version ${pending.version_label} is already in review`, { messageKey: 'files.version_in_review' });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------------------------------------------

  /** A provider item to link: the repository must offer link mode, be usable (BR-29) and have a folder for the system. */
  private async linkSource(trx: Trx, orgId: string, ms: FilesMs, slug: string, externalItemId: string): Promise<LinkSource> {
    const repository = await this.common.storage.repositoryBySlug(trx, slug);
    const scopeRoot = scopeRootOf(repository, ms);
    if (!repository.modes.includes('link')) {
      throw refusal('files.link_not_supported', {
        en: `Repository ${repository.name} does not link existing files.`,
        id: `Repositori ${repository.name} tidak menautkan berkas yang sudah ada.`,
      });
    }
    await assertRepositoryUsable(repository, this.common.adapters(orgId));
    return {
      kind: 'link',
      repository,
      tenant: await this.common.storage.tenant(trx, orgId),
      descriptor: await this.common.storage.repository(trx, repository),
      scopeRoot,
      externalItemId,
    };
  }

  /** Gateway `link`: the current version of the item, which must lie below the system root (422 otherwise). */
  private link(source: LinkSource): Promise<ObjectMetadata> {
    return viaGateway(source.repository, () =>
      this.gateway.post<ObjectMetadata>('/v1/link', { tenant: source.tenant, repository: source.descriptor, scopeRoot: source.scopeRoot, externalItemId: source.externalItemId }),
    );
  }

  /** Google Drive keeps the pinned revision (`keepForever`, TS 5.3). */
  private async pin(source: LinkSource, metadata: ObjectMetadata): Promise<void> {
    await viaGateway(source.repository, () =>
      this.gateway.post<PinVersionResult>('/v1/pin-version', { tenant: source.tenant, repository: source.descriptor, object: providerObjectRef(metadata) }),
    );
  }

  /** A finished upload of the caller for this record (409 when it does not match or is not uploaded). */
  private async intentSource(trx: Trx, principal: Principal, ms: FilesMs, kind: 'evidence' | 'document', recordId: string, intentId: string, modes: readonly UploadMode[]): Promise<IntentSource> {
    const intent = await this.readIntent(trx, intentId, principal.user.id);
    if (!intent || intent.object_kind !== kind || intent.target_id !== recordId || intent.management_system_id !== ms.id) {
      throw new ConflictError('The upload intent is not for this record', { messageKey: 'files.intent_mismatch' });
    }
    if (!modes.includes(intent.mode)) throw new ConflictError(`The upload intent is for mode ${intent.mode}`, { messageKey: 'files.intent_mismatch' });
    if (intent.status !== 'uploaded' || !intent.storage_object_id) {
      throw new ConflictError('The upload intent has no finished upload', { messageKey: 'files.intent_not_uploaded' });
    }
    const repository = await trx.selectFrom('storage_repository').selectAll().where('id', '=', intent.storage_repository_id).executeTakeFirstOrThrow();
    return { kind: 'intent', intentId: intent.id, storageObjectId: intent.storage_object_id, mode: intent.mode, repository };
  }

  private async readIntent(trx: Trx, id: string, userId: string, forUpdate = false): Promise<AttachIntent | undefined> {
    let query = trx
      .selectFrom('upload_intent')
      .select(['id', 'status', 'mode', 'object_kind', 'target_id', 'management_system_id', 'storage_object_id', 'storage_repository_id'])
      .where('id', '=', id)
      .where('created_by', '=', userId)
      .where('deleted_at', 'is', null);
    if (forUpdate) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** Locks the intent and checks it is still `uploaded` (two attaches of one upload: the second gets 409). */
  private async lockIntent(trx: Trx, intentId: string): Promise<void> {
    const row = await trx.selectFrom('upload_intent').select('status').where('id', '=', intentId).forUpdate().executeTakeFirstOrThrow();
    if (row.status !== 'uploaded') throw new ConflictError('The upload intent has no finished upload', { messageKey: 'files.intent_not_uploaded' });
  }

  private async completeIntent(trx: Trx, intentId: string, userId: string, now: Date): Promise<void> {
    await trx.updateTable('upload_intent').set({ status: 'completed', updated_at: now, updated_by: userId }).where('id', '=', intentId).execute();
  }

  /** The object of a finished upload. */
  private async objectOfIntent(trx: Trx, objectId: string): Promise<NewObject> {
    const object = await this.common.object(trx, objectId);
    return {
      id: object.id,
      versionLabel: object.version_label,
      hashAlgorithm: object.hash_algorithm,
      hashValue: object.hash_value,
      sizeBytes: object.size_bytes === null ? null : Number(object.size_bytes),
      providerCreatedAt: object.provider_created_at,
    };
  }
}
