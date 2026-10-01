// `export.build` (build plan E.2; payload `{taskId}`, singleton key `ex:<taskId>`, 2 retries):
//
// 1. The `background_task` of kind `export` becomes `running`; the requester (`created_by`) is rebuilt as a
//    principal without a session and the D.3 permission is checked again (a requester who lost it gets a failed
//    task, without retries).
// 2. The file is built for the requester (`ExportContentService`, so `ScopePolicy` applies as on the screens), in
//    the requester's language.
// 3. It is stored in the organisation's Managed Vault under `exports/<taskId>/` (gateway `PUT /v1/objects`).
// 4. One transaction records the `storage_object`, the `export_file` (expires after 7 days), the task result
//    (`succeeded`) and the `export_ready` notification to the requester with the download link.
//
// A failure marks the task `failed` with the reason and is thrown again so the queue retries; a later attempt starts
// from step 1. A task that already succeeded is left alone (idempotent).
import { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PutResult } from '@mscd/shared';
import { Clock } from '../../common/clock';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { GATEWAY_CLIENT, NOTIFICATION_WRITER, SYSTEM_USER_ID, type GatewayClient, type NotificationWriter, type Principal, type TenantInfo, type Trx } from '../../common/tokens';
import { StorageGatewayContext } from '../storage/gateway-context';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import { ExportContentService, type ExportSpec, type Lang } from './export-content.service';
import { exportDownloadUrl, exportTypeName, specOf } from './exports.service';

/** Days an export file stays downloadable (E.2). */
export const EXPORT_RETENTION_DAYS = 7;
/** Largest export the job stores. */
const EXPORT_MAX_BYTES = 512 * 1024 * 1024;

export interface ExportBuildResult {
  taskId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  fileName?: string;
  error?: string;
}

/** A failure that another attempt cannot fix: the task fails without a retry. */
class FinalExportError extends Error {}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

interface Prepared {
  spec: ExportSpec;
  principal: Principal | null;
  language: Lang;
  msId: string | null;
}

@Injectable()
@JobHandler('export.build', { concurrency: 2, scope: 'tenant' })
export class ExportBuildJob implements JobHandlerInstance<'export.build'> {
  private readonly logger = new Logger('export.build');

  constructor(
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    private readonly content: ExportContentService,
    private readonly storage: StorageGatewayContext,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  async handle(job: JobRun<'export.build'>): Promise<void> {
    const result = await this.build(job.env.orgId, job.env.payload.taskId, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, ...result }, 'export.build done');
  }

  /** Builds one export (E.2). Throws after recording a failure that another attempt may fix. */
  async build(orgId: string | null, taskId: string, requestId?: string): Promise<ExportBuildResult> {
    if (!orgId) throw new Error('export.build needs the organisation of the job envelope');
    const org = await this.tenants.resolveById(orgId);
    // Exports keep running for offboarding organisations (D.1 Organisation status).
    if (!org || (org.status !== 'active' && org.status !== 'offboarding')) return { taskId, status: 'skipped' };
    const context = systemContextOf(org, requestId);
    const prepared = await this.scope.withTenant(context, (trx) => this.prepare(trx, org, taskId));
    if (!prepared) return { taskId, status: 'skipped' };
    try {
      if (!prepared.principal || !(await this.content.allowed(prepared.principal, prepared.spec))) {
        throw new FinalExportError('The requester no longer holds the permission this export needs');
      }
      const file = await this.content.build(prepared.principal, prepared.spec, prepared.language);
      await this.progress(org, taskId, 60, requestId);
      const stored = await this.store(org, taskId, file.fileName, Buffer.isBuffer(file.body) ? Readable.from([file.body]) : file.body, requestId);
      await this.scope.withTenant(context, (trx) => this.complete(trx, prepared, taskId, file.fileName, stored));
      return { taskId, status: 'succeeded', fileName: file.fileName };
    } catch (error) {
      const message = errorText(error);
      await this.scope.withTenant(context, (trx) =>
        trx
          .updateTable('background_task')
          .set({ status: 'failed', error: message, finished_at: this.clock.now(), updated_at: this.clock.now(), updated_by: SYSTEM_USER_ID })
          .where('id', '=', taskId)
          .execute(),
      );
      this.logger.warn({ orgId, taskId }, `export.build failed: ${message}`);
      if (error instanceof FinalExportError) return { taskId, status: 'failed', error: message };
      throw error;
    }
  }

  private async prepare(trx: Trx, org: TenantInfo, taskId: string): Promise<Prepared | null> {
    const task = await trx
      .selectFrom('background_task')
      .select(['id', 'status', 'params', 'created_by', 'management_system_id'])
      .where('id', '=', taskId)
      .where('kind', '=', 'export')
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!task) {
      this.logger.warn({ orgId: org.id, taskId }, 'export.build: no such task');
      return null;
    }
    if (task.status === 'succeeded') return null;
    const now = this.clock.now();
    await trx
      .updateTable('background_task')
      .set({ status: 'running', progress: 10, started_at: now, error: null, updated_at: now, updated_by: SYSTEM_USER_ID })
      .where('id', '=', task.id)
      .execute();
    const principal = task.created_by ? await this.content.principalFor(trx, org, task.created_by) : null;
    const language = task.created_by ? await this.content.languageOf(trx, task.created_by) : 'en';
    return { spec: specOf(task.params), principal, language, msId: task.management_system_id };
  }

  private async progress(org: TenantInfo, taskId: string, progress: number, requestId?: string): Promise<void> {
    await this.scope.withTenant(systemContextOf(org, requestId), (trx) =>
      trx.updateTable('background_task').set({ progress, updated_at: this.clock.now() }).where('id', '=', taskId).execute(),
    );
  }

  /** Step 3: `PUT /v1/objects` into the organisation's Managed Vault, folder `exports/<taskId>`. */
  private async store(org: TenantInfo, taskId: string, fileName: string, body: Readable, requestId?: string): Promise<{ repositoryId: string; result: PutResult }> {
    const target = await this.scope.withTenant(systemContextOf(org, requestId), async (trx) => {
      const row = await trx
        .selectFrom('storage_repository')
        .selectAll()
        .where('adapter', '=', 'managed_vault')
        .where('deleted_at', 'is', null)
        .orderBy('position')
        .orderBy('slug')
        .executeTakeFirst();
      if (!row) throw new FinalExportError('The organisation has no Managed Vault to hold exports');
      return { row, descriptor: await this.storage.repository(trx, row), tenant: await this.storage.tenant(trx, org.id) };
    });
    const header = {
      tenant: target.tenant,
      repository: target.descriptor,
      scopeRoot: { folderId: null, path: '' },
      folderPath: `exports/${taskId}`,
      fileName,
      maxBytes: EXPORT_MAX_BYTES,
      metadataMinimization: target.row.metadata_minimization,
    };
    const result = await this.gateway.putObject<PutResult>(header, body, requestId ? { requestId } : undefined);
    return { repositoryId: target.row.id, result };
  }

  /** Step 4, in one transaction. */
  private async complete(trx: Trx, prepared: Prepared, taskId: string, fileName: string, stored: { repositoryId: string; result: PutResult }): Promise<void> {
    const now = this.clock.now();
    const r = stored.result;
    const object = await trx
      .insertInto('storage_object')
      .values({
        storage_repository_id: stored.repositoryId,
        external_item_id: r.externalItemId,
        external_version_id: r.externalVersionId,
        version_label: r.versionLabel.slice(0, 30),
        display_name: fileName,
        mime_type: r.detectedMimeType.slice(0, 100),
        size_bytes: String(r.sizeBytes),
        hash_algorithm: 'sha256',
        hash_value: r.hashValue,
        hash_source: 'computed',
        provider_created_at: r.providerCreatedAt ? new Date(r.providerCreatedAt) : now,
        provider_modified_at: r.providerCreatedAt ? new Date(r.providerCreatedAt) : now,
        folder_path: r.folderPath,
        web_url: r.webUrl ?? null,
        encryption: r.encryption ? JSON.stringify(r.encryption) : null,
        link_status: 'intact',
        link_status_since: now,
        last_verified_at: now,
        last_good_check_at: now,
        created_by: SYSTEM_USER_ID,
        updated_by: SYSTEM_USER_ID,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const requester = prepared.principal?.user.id ?? null;
    const file = await trx
      .insertInto('export_file')
      .values({
        kind: prepared.spec.type,
        format: prepared.spec.format,
        management_system_id: prepared.msId,
        background_task_id: taskId,
        storage_object_id: object.id,
        file_name: fileName.slice(0, 200),
        expires_at: new Date(now.getTime() + EXPORT_RETENTION_DAYS * 86_400_000),
        created_by: requester,
        updated_by: requester,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('background_task')
      .set({
        status: 'succeeded',
        progress: 100,
        result: JSON.stringify({ exportFileId: file.id, fileName, sizeBytes: Number(r.sizeBytes), type: prepared.spec.type, format: prepared.spec.format }),
        error: null,
        finished_at: now,
        updated_at: now,
        updated_by: SYSTEM_USER_ID,
      })
      .where('id', '=', taskId)
      .execute();
    if (requester) {
      const name = exportTypeName(prepared.spec.type);
      await this.notifications.create(trx, {
        recipientUserId: requester,
        kind: 'export_ready',
        msId: prepared.msId,
        title: { en: `Export ready: ${name[0]}`, id: `Ekspor siap: ${name[1]}` },
        body: {
          en: `${fileName} is ready to download for ${EXPORT_RETENTION_DAYS} days: ${exportDownloadUrl(taskId)}`,
          id: `${fileName} siap diunduh selama ${EXPORT_RETENTION_DAYS} hari: ${exportDownloadUrl(taskId)}`,
        },
        ref: { module: 'admin', entityType: 'background_task', id: taskId, code: fileName },
        createdBy: SYSTEM_USER_ID,
      });
    }
  }
}
