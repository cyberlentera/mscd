// Evidence pack routes (build plan D.3, E.7, D-34, F.13):
// - `request` (`POST /ms/{ms}/evidence-packs`, `evidence_pack.build`): a queued pack, its `background_task` and the
//   `evidence-pack.build` job in one transaction; 202 with the task id and the repository that receives the files.
// - `list` and `get` (`ms.read`): packs of the system through `ScopePolicy`: external auditors see `ready` packs of
//   their system only; owner-scoped readers see the items of their own evidence; classification applies to items.
// - `download`: a manifest or the archive of a ready pack through `FileResponder` (attachment, audited
//   `evidence_pack.downloaded`). Top Management has no file access (TS 7.3) and owner-scoped readers cannot download
//   manifests that list everyone's evidence.
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, EvidencePackDownloadQuery, EvidencePackItem, EvidencePackRequest, EvidencePackView, Page } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FileResponder } from '../../common/file-response';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/problems';
import { GATEWAY_CLIENT, JOB_QUEUE, type GatewayClient, type JobQueue, type Principal, type Trx } from '../../common/tokens';
import { addAuditorReadRefs } from '../authz/auditor-read';
import { ScopePolicyService, type ScopeContext } from '../authz/scope-policy';
import { StorageGatewayContext } from '../storage/gateway-context';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { downloadName, packUrls } from './pack-support';

interface SystemRow {
  id: string;
  slug: string;
  code: string;
  default_storage_repository_id: string | null;
}

interface PackRow {
  id: string;
  status: 'queued' | 'building' | 'ready' | 'failed';
  audit_event_id: string | null;
  pack_folder: string | null;
  manifest_pdf_object_id: string | null;
  manifest_csv_object_id: string | null;
  archive_object_id: string | null;
  item_count: number;
  exception_count: number;
  built_at: Date | null;
}

const PACK_COLUMNS = [
  'id',
  'status',
  'audit_event_id',
  'pack_folder',
  'manifest_pdf_object_id',
  'manifest_csv_object_id',
  'archive_object_id',
  'item_count',
  'exception_count',
  'built_at',
] as const;

@Injectable()
export class EvidencePacksService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: ScopePolicyService,
    private readonly storage: StorageGatewayContext,
    private readonly files: FileResponder,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
  ) {}

  /** `POST /ms/{ms}/evidence-packs` (202). */
  async request(principal: Principal, ms: string, body: EvidencePackRequest): Promise<CommandResult> {
    const orgId = principal.org!.id;
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms);
      if (body.auditEventId) {
        const event = await trx
          .selectFrom('audit_event')
          .select('id')
          .where('id', '=', body.auditEventId)
          .where('management_system_id', '=', system.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!event) throw new NotFoundError('No such audit event in this management system');
      }
      const scope = {
        ...(body.scope?.clauses && body.scope.clauses.length > 0 ? { clauses: [...new Set(body.scope.clauses)] } : {}),
        ...(body.scope?.codes && body.scope.codes.length > 0 ? { codes: [...new Set(body.scope.codes)] } : {}),
      };
      const user = principal.user.id;
      const task = await trx
        .insertInto('background_task')
        .values({ kind: 'evidence_pack', management_system_id: system.id, status: 'queued', params: JSON.stringify({ auditEventId: body.auditEventId ?? null, scope }), created_by: user, updated_by: user })
        .returning('id')
        .executeTakeFirstOrThrow();
      const pack = await trx
        .insertInto('evidence_pack')
        .values({
          management_system_id: system.id,
          audit_event_id: body.auditEventId ?? null,
          background_task_id: task.id,
          scope: JSON.stringify(scope),
          status: 'queued',
          created_by: user,
          updated_by: user,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('background_task')
        .set({ params: JSON.stringify({ packId: pack.id, auditEventId: body.auditEventId ?? null, scope }) })
        .where('id', '=', task.id)
        .execute();
      const jobId = await this.jobs.send('evidence-pack.build', { orgId, requestedBy: user, payload: { packId: pack.id } }, { singletonKey: `ep:${pack.id}`, retryLimit: 2 }, trx);
      if (jobId) await trx.updateTable('background_task').set({ job_id: jobId.slice(0, 80) }).where('id', '=', task.id).execute();
      const repository = await this.manifestRepository(trx, system);
      return {
        ok: true,
        changed: [ms],
        taskId: task.id,
        message: [`Evidence pack queued; files go to ${repository}`, `Paket bukti dalam antrean; berkas disimpan di ${repository}`],
        data: { packId: pack.id },
      };
    });
  }

  /** `GET /ms/{ms}/evidence-packs`. */
  async list(request: FastifyRequest, principal: Principal, ms: string, query: { page: number; pageSize: number }): Promise<Page<EvidencePackView>> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms);
      const ctx = await this.policy.scopeContext(trx, principal, ms);
      let base = trx.selectFrom('evidence_pack').where('management_system_id', '=', system.id).where('deleted_at', 'is', null);
      if (ctx.kind === 'external_auditor') base = base.where('status', '=', 'ready');
      const total = Number((await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
      const rows = await base
        .select(PACK_COLUMNS)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      const items: EvidencePackView[] = [];
      for (const row of rows) items.push(await this.view(trx, ctx, ms, row));
      this.auditorRefs(request, items);
      return { items, page: query.page, pageSize: query.pageSize, total };
    });
  }

  /** `GET /ms/{ms}/evidence-packs/{id}`. */
  async get(request: FastifyRequest, principal: Principal, ms: string, id: string): Promise<EvidencePackView> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms);
      const ctx = await this.policy.scopeContext(trx, principal, ms);
      const row = await this.pack(trx, system.id, id, ctx);
      const view = await this.view(trx, ctx, ms, row);
      this.auditorRefs(request, [view]);
      return view;
    });
  }

  /** `GET /ms/{ms}/evidence-packs/{id}/download?file=...` through `FileResponder` (F.13). */
  async download(request: FastifyRequest, reply: FastifyReply, principal: Principal, ms: string, id: string, query: EvidencePackDownloadQuery): Promise<FastifyReply> {
    const prepared = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms);
      const ctx = await this.policy.scopeContext(trx, principal, ms);
      if (ctx.kind === 'top_management') throw new ForbiddenError('Top Management has no file access');
      if (ctx.kind === 'own') throw new ForbiddenError('Pack manifests list every evidence record of the system; ask an MS Manager');
      const pack = await this.pack(trx, system.id, id, ctx);
      if (pack.status !== 'ready') throw new ConflictError('The evidence pack is not ready yet');
      const objectId =
        query.file === 'manifest_pdf' ? pack.manifest_pdf_object_id : query.file === 'manifest_csv' ? pack.manifest_csv_object_id : pack.archive_object_id;
      if (!objectId) throw new NotFoundError('This evidence pack has no such file');
      const object = await trx.selectFrom('storage_object').selectAll().where('id', '=', objectId).where('deleted_at', 'is', null).executeTakeFirst();
      if (!object) throw new NotFoundError('The file of this evidence pack is gone');
      const repositoryRow = await this.storage.repositoryRow(trx, object.storage_repository_id);
      return {
        system,
        pack,
        object,
        tenant: await this.storage.tenant(trx, principal.org!.id),
        repository: await this.storage.repository(trx, repositoryRow),
      };
    });
    const { object } = prepared;
    const streamed = await this.gateway.stream({
      tenant: prepared.tenant,
      repository: prepared.repository,
      object: {
        externalItemId: object.external_item_id,
        externalVersionId: object.external_version_id,
        hashAlgorithm: object.hash_algorithm,
        hashValue: object.hash_value,
        hashSource: object.hash_source,
        folderPath: object.folder_path,
      },
    });
    const storedType = query.file === 'manifest_pdf' ? 'application/pdf' : query.file === 'manifest_csv' ? 'text/csv' : (object.mime_type ?? streamed.detectedType);
    addAuditorReadRefs(request, [{ entityType: 'evidence_pack', id: prepared.pack.id, code: downloadName(prepared.system.code, prepared.pack.pack_folder, query.file) }]);
    return this.files.send(reply, {
      body: streamed.stream,
      storedType,
      fileName: downloadName(prepared.system.code, prepared.pack.pack_folder, query.file),
      size: streamed.size ?? (object.size_bytes === null ? null : Number(object.size_bytes)),
      audit: {
        action: 'evidence_pack.downloaded',
        msId: prepared.system.id,
        entityType: 'evidence_pack',
        entityId: prepared.pack.id,
        entityCode: prepared.pack.pack_folder,
        after: { file: query.file, storageObjectId: object.id },
      },
    });
  }

  // -------------------------------------------------------------------------------------------------------------

  private async system(trx: Trx, ms: string): Promise<SystemRow> {
    const row = await trx
      .selectFrom('management_system')
      .select(['id', 'slug', 'code', 'default_storage_repository_id'])
      .where('slug', '=', ms)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Unknown management system');
    return row;
  }

  /** One pack of the system as the caller may see it (external auditors: ready packs only); 404 otherwise. */
  private async pack(trx: Trx, msId: string, id: string, ctx: ScopeContext): Promise<PackRow> {
    let query = trx.selectFrom('evidence_pack').select(PACK_COLUMNS).where('id', '=', id).where('management_system_id', '=', msId).where('deleted_at', 'is', null);
    if (ctx.kind === 'external_auditor') query = query.where('status', '=', 'ready');
    const row = await query.executeTakeFirst();
    if (!row) throw new NotFoundError('No such evidence pack');
    return row;
  }

  /** The name of the repository that receives the manifests (default repository, else the Managed Vault). */
  private async manifestRepository(trx: Trx, system: SystemRow): Promise<string> {
    if (system.default_storage_repository_id) {
      const row = await trx.selectFrom('storage_repository').select(['name', 'modes']).where('id', '=', system.default_storage_repository_id).where('deleted_at', 'is', null).executeTakeFirst();
      if (row && (row.modes.includes('stored') || row.modes.includes('pass_through'))) return row.name;
    }
    const vault = await trx.selectFrom('storage_repository').select('name').where('adapter', '=', 'managed_vault').where('deleted_at', 'is', null).orderBy('position').executeTakeFirst();
    return vault?.name ?? 'Managed Vault';
  }

  private async view(trx: Trx, ctx: ScopeContext, ms: string, row: PackRow): Promise<EvidencePackView> {
    const items = await trx
      .selectFrom('evidence_pack_item as i')
      .innerJoin('evidence as e', 'e.id', 'i.evidence_id')
      .select([
        'i.evidence_id',
        'i.evidence_code',
        'i.requirement_codes',
        'i.produced_at',
        'i.external_version_id',
        'i.hash_algorithm',
        'i.hash_value',
        'i.link_status',
        'i.copy_location',
        'i.copy_storage_object_id',
        'i.is_deleted_record',
        'i.exception_reason',
        'e.owner_user_id',
        'e.classification',
      ])
      .where('i.evidence_pack_id', '=', row.id)
      .orderBy('i.created_at')
      .orderBy('i.evidence_code')
      .execute();
    const visible = this.policy.filterRecords(
      ctx,
      items.map((i) => ({ ...i, ownerUserId: i.owner_user_id, classification: i.classification, evidenceId: ctx.kind === 'external_auditor' ? i.evidence_id : undefined })),
    );
    const views: EvidencePackItem[] = visible.map((i) => ({
      evidenceCode: i.evidence_code,
      requirementCodes: [...i.requirement_codes],
      producedAt: i.produced_at,
      externalVersionId: i.external_version_id,
      hashAlgorithm: i.hash_algorithm as EvidencePackItem['hashAlgorithm'],
      hashValue: i.hash_value,
      linkStatus: i.link_status as EvidencePackItem['linkStatus'],
      copyLocation: i.copy_location,
      deleted: i.is_deleted_record,
      exceptionReason: i.exception_reason,
      ...(i.copy_storage_object_id ? { copyObjectId: i.copy_storage_object_id } : {}),
    }));
    return {
      id: row.id,
      status: row.status,
      auditEventId: row.audit_event_id,
      packFolder: row.pack_folder,
      itemCount: row.item_count,
      exceptionCount: row.exception_count,
      ...packUrls(ms, row.id, row.archive_object_id !== null),
      builtAt: row.built_at?.toISOString() ?? null,
      items: views,
    };
  }

  /** `auditor.read` lists the packs an external auditor read (no-op for other callers). */
  private auditorRefs(request: FastifyRequest, views: readonly EvidencePackView[]): void {
    addAuditorReadRefs(
      request,
      views.map((v) => ({ entityType: 'evidence_pack', id: v.id, code: v.packFolder ?? v.id })),
    );
  }
}
