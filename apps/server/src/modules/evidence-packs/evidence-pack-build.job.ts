// `evidence-pack.build` (build plan E.2, E.7; payload `{packId}`, singleton key `ep:<packId>`, 2 retries):
//
// 1. Scope: evidence of the system that targets entries in scope (`scope.clauses`, `scope.codes`, default all),
//    produced within the current certification cycle, plus evidence soft-deleted after the cycle start (flagged,
//    A-09).
// 2. Pack folder `<root>/_packs/<MS code>/<event short label or YYYY-MM-DD>/` (TS 5.4), created with gateway
//    `ensure-folder` in every repository that holds pack evidence.
// 3. Evidence whose file is `intact` or `moved` is copied with gateway `copy-within` into the pack folder of its own
//    repository; everything else is an exception with its reason (BR-34, A-10). A copy that fails is an exception
//    too. Every copy is recorded as a `storage_object`, which is all an external auditor can open (D-34).
// 4. The CSV and PDF manifests go to the pack folder of the system's default repository (`PUT /v1/objects`), or of
//    the organisation's Managed Vault when that repository cannot store files (link-only modes).
// 5. When the manifests are in the Managed Vault, a `.tar.gz` of the vault copies and both manifests is stored as
//    one more object (PRD 11.5).
// 6. `evidence_pack` and `evidence_pack_item` rows, the `background_task` result, the `evidence_pack_ready`
//    notification to the requester and the audit entry `evidence_pack.built`, in one transaction.
//
// Idempotent: a `ready` pack is left alone; a failed or interrupted build starts again from step 1 (copies of an
// interrupted attempt stay in the provider folder, renamed by the provider on the next attempt, and are not
// referenced by any row).
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CopyWithinResult, EnsureFolderResponse, GatewayObjectRef, GatewayRepository, GatewayTenant, ListResponse, PutResult, ScopeRoot } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { fmtDay } from '../../common/dates';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import {
  AUDIT_WRITER,
  GATEWAY_CLIENT,
  NOTIFICATION_WRITER,
  SYSTEM_USER_ID,
  type AuditWriter,
  type GatewayClient,
  type NotificationWriter,
  type TenantInfo,
  type Trx,
} from '../../common/tokens';
import { StorageGatewayContext } from '../storage/gateway-context';
import type { RepositoryRow } from '../storage/repository-view';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import { manifestCsv, manifestPdf, type ManifestItem } from './pack-manifest';
import {
  ARCHIVE_NAME,
  COPYABLE_STATUSES,
  exceptionReason,
  joinFolder,
  MANIFEST_CSV_NAME,
  MANIFEST_PDF_NAME,
  packFolderPath,
  packLabel,
  VAULT_PACK_ROOT,
} from './pack-support';
import { tarStream, type TarEntry } from './tar-stream';

/** Largest manifest or archive the build stores (the archive holds every vault copy of the pack). */
const PACK_OBJECT_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, kind: 'system' as const };

export interface PackScope {
  clauses?: string[];
  codes?: string[];
}

interface PackRow {
  id: string;
  status: string;
  created_by: string | null;
  audit_event_id: string | null;
  background_task_id: string | null;
  management_system_id: string;
  scope: PackScope;
}

interface SystemRow {
  id: string;
  slug: string;
  code: string;
  name: string;
  default_storage_repository_id: string | null;
  edition: string | null;
}

interface StoredFile {
  id: string;
  repositoryId: string;
  externalItemId: string;
  externalVersionId: string | null;
  versionLabel: string | null;
  displayName: string | null;
  mimeType: string | null;
  sizeBytes: string | null;
  hashAlgorithm: string;
  hashValue: string | null;
  hashSource: string;
  folderPath: string | null;
  linkStatus: string;
  encryption: unknown;
}

interface EvidenceInput {
  id: string;
  code: string;
  title: string;
  producedAt: string | null;
  deleted: boolean;
  file: StoredFile | null;
  requirementCodes: string[];
}

interface RepositoryTarget {
  row: RepositoryRow;
  descriptor: GatewayRepository;
}

interface BuildInput {
  org: TenantInfo;
  pack: PackRow;
  system: SystemRow;
  event: { shortLabel: string; name: string; scheduledAt: string } | null;
  cycleStart: string | null;
  today: string;
  label: string;
  tenant: GatewayTenant;
  repositories: Map<string, RepositoryTarget>;
  /** Root folder path of each provider repository (from the drive root), read once per build. */
  rootPaths: Map<string, string>;
  manifestRepositoryId: string;
  evidence: EvidenceInput[];
}

/** A copy made in step 3, recorded in step 6. */
interface MadeCopy {
  repositoryId: string;
  newItemId: string;
  location: string;
  source: StoredFile;
}

/** One pack item before it is written. */
interface PlannedItem {
  evidence: EvidenceInput;
  copy: MadeCopy | null;
  exception: string | null;
}

/** A manifest or archive stored in step 4 or 5. */
interface StoredPackObject {
  repositoryId: string;
  name: string;
  result: PutResult;
}

export interface EvidencePackBuildResult {
  packId: string;
  status: 'ready' | 'skipped';
  itemCount: number;
  exceptionCount: number;
  packFolder: string | null;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function locationFolder(location: string): string {
  const parts = location.split('/');
  parts.pop();
  return parts.join('/');
}

function objectRef(file: StoredFile): GatewayObjectRef {
  return {
    externalItemId: file.externalItemId,
    externalVersionId: file.externalVersionId,
    hashAlgorithm: file.hashAlgorithm as GatewayObjectRef['hashAlgorithm'],
    hashValue: file.hashValue,
    hashSource: file.hashSource as GatewayObjectRef['hashSource'],
    folderPath: file.folderPath,
  };
}

/** True when a repository can receive manifests through `PUT /v1/objects` (stored or pass-through). */
function canStore(row: RepositoryRow): boolean {
  return row.modes.includes('stored') || row.modes.includes('pass_through');
}

@Injectable()
@JobHandler('evidence-pack.build', { concurrency: 1, scope: 'tenant' })
export class EvidencePackBuildJob implements JobHandlerInstance<'evidence-pack.build'> {
  private readonly logger = new Logger('evidence-pack.build');

  constructor(
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    private readonly storage: StorageGatewayContext,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  async handle(job: JobRun<'evidence-pack.build'>): Promise<void> {
    const result = await this.build(job.env.orgId, job.env.payload.packId, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, ...result }, 'evidence-pack.build done');
  }

  /** Builds one pack (E.7). Throws after recording the failure, so the queue retries. */
  async build(orgId: string | null, packId: string, requestId?: string): Promise<EvidencePackBuildResult> {
    if (!orgId) throw new Error('evidence-pack.build needs the organisation of the job envelope');
    const org = await this.tenants.resolveById(orgId);
    if (!org || org.status === 'archived') return { packId, status: 'skipped', itemCount: 0, exceptionCount: 0, packFolder: null };
    const context = systemContextOf(org, requestId);
    const input = await this.scope.withTenant(context, (trx) => this.prepare(trx, org, packId));
    if (!input) return { packId, status: 'skipped', itemCount: 0, exceptionCount: 0, packFolder: null };
    try {
      const { folders, items } = await this.copy(input);
      const manifestFolder = folders.get(input.manifestRepositoryId) ?? (await this.ensureFolder(input, input.manifestRepositoryId));
      folders.set(input.manifestRepositoryId, manifestFolder);
      const manifestItems = items.map((item) => this.manifestItem(item));
      const packFolder = `/${manifestFolder}/`;
      const csv = manifestCsv(manifestItems);
      const pdf = await manifestPdf(
        {
          organisation: org.name,
          systemCode: input.system.code,
          systemName: input.system.name,
          edition: input.system.edition,
          event: input.event ? `${input.event.name} (${fmtDay(input.event.scheduledAt)})` : null,
          packLabel: input.label,
          packFolder,
          builtOn: fmtDay(input.today),
          cycleStart: input.cycleStart ? fmtDay(input.cycleStart) : null,
        },
        manifestItems,
      );
      const stored: StoredPackObject[] = [];
      stored.push(await this.put(input, input.manifestRepositoryId, manifestFolder, MANIFEST_CSV_NAME, csv));
      stored.push(await this.put(input, input.manifestRepositoryId, manifestFolder, MANIFEST_PDF_NAME, pdf));
      const manifestRepo = input.repositories.get(input.manifestRepositoryId)!;
      if (manifestRepo.row.adapter === 'managed_vault') {
        stored.push(await this.archive(input, manifestFolder, items, csv, pdf));
      }
      return await this.scope.withTenant(context, (trx) => this.complete(trx, input, items, stored, packFolder));
    } catch (error) {
      await this.scope.withTenant(context, (trx) => this.fail(trx, input, error));
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------------------------- step 1

  private async prepare(trx: Trx, org: TenantInfo, packId: string): Promise<BuildInput | null> {
    const pack = await trx
      .selectFrom('evidence_pack')
      .select(['id', 'status', 'created_by', 'audit_event_id', 'background_task_id', 'management_system_id', 'scope'])
      .where('id', '=', packId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!pack) {
      this.logger.warn({ packId, orgId: org.id }, 'evidence-pack.build: no such pack');
      return null;
    }
    if (pack.status === 'ready') return null;
    const now = this.clock.now();
    const today = await this.clock.today(org.id);
    await trx.updateTable('evidence_pack').set({ status: 'building', updated_at: now, updated_by: SYSTEM_USER_ID }).where('id', '=', pack.id).execute();
    if (pack.background_task_id) {
      await trx
        .updateTable('background_task')
        .set({ status: 'running', progress: 5, started_at: now, error: null, updated_at: now })
        .where('id', '=', pack.background_task_id)
        .execute();
    }

    const { rows: systems } = await sql<SystemRow>`
      select ms.id, ms.slug, ms.code, ms.name, ms.default_storage_repository_id,
             fv.pack_id || ' ' || fv.pack_version as edition
      from management_system ms
      left join ref.framework_version fv on fv.id = ms.framework_version_id
      where ms.id = ${pack.management_system_id}`.execute(trx);
    const system = systems[0];
    if (!system) throw new Error(`Evidence pack ${pack.id}: the management system is gone`);

    const event = pack.audit_event_id
      ? await trx
          .selectFrom('audit_event')
          .select(['short_label', 'name_en', 'scheduled_at'])
          .where('id', '=', pack.audit_event_id)
          .executeTakeFirst()
      : undefined;
    const cycle = await trx
      .selectFrom('certification_cycle')
      .select(['cycle_start'])
      .where('management_system_id', '=', system.id)
      .where('deleted_at', 'is', null)
      .where('cycle_start', '<=', today)
      .orderBy('cycle_start', 'desc')
      .limit(1)
      .executeTakeFirst();
    const cycleStart = cycle?.cycle_start ?? null;

    const evidence = await this.evidenceInScope(trx, system.id, (pack.scope ?? {}) as PackScope, cycleStart);
    const tenant = await this.storage.tenant(trx, org.id);
    const repositories = new Map<string, RepositoryTarget>();
    const addRepository = async (row: RepositoryRow) => {
      if (!repositories.has(row.id)) repositories.set(row.id, { row, descriptor: await this.storage.repository(trx, row) });
    };
    for (const item of evidence) {
      if (item.file && COPYABLE_STATUSES.has(item.file.linkStatus) && !repositories.has(item.file.repositoryId)) {
        await addRepository(await this.storage.repositoryRow(trx, item.file.repositoryId));
      }
    }
    let manifestRow: RepositoryRow | null = null;
    if (system.default_storage_repository_id) {
      const row = await this.storage.repositoryRow(trx, system.default_storage_repository_id).catch(() => null);
      if (row && canStore(row)) manifestRow = row;
    }
    if (!manifestRow) {
      manifestRow =
        (await trx.selectFrom('storage_repository').selectAll().where('adapter', '=', 'managed_vault').where('deleted_at', 'is', null).orderBy('position').executeTakeFirst()) ?? null;
    }
    if (!manifestRow) throw new Error('The organisation has no repository that can store the pack manifests');
    await addRepository(manifestRow);

    const label = await this.uniqueLabel(trx, pack, system, packLabel(event?.short_label ?? today));
    return {
      org,
      pack: { ...pack, scope: (pack.scope ?? {}) as PackScope },
      system,
      event: event ? { shortLabel: event.short_label, name: event.name_en, scheduledAt: event.scheduled_at } : null,
      cycleStart,
      today,
      label,
      tenant,
      repositories,
      rootPaths: new Map(),
      manifestRepositoryId: manifestRow.id,
      evidence,
    };
  }

  /** E.7 step 1: the evidence of the system in scope, with its file and requirement codes. */
  private async evidenceInScope(trx: Trx, msId: string, scope: PackScope, cycleStart: string | null): Promise<EvidenceInput[]> {
    const { rows } = await sql<{
      id: string;
      evidence_code: string;
      title: string;
      produced_at: string | null;
      deleted_at: Date | null;
      codes: string[];
      clauses: string[];
      so_id: string | null;
      storage_repository_id: string | null;
      external_item_id: string | null;
      external_version_id: string | null;
      version_label: string | null;
      display_name: string | null;
      mime_type: string | null;
      size_bytes: string | null;
      hash_algorithm: string | null;
      hash_value: string | null;
      hash_source: string | null;
      folder_path: string | null;
      link_status: string | null;
      encryption: unknown;
    }>`
      select e.id, e.evidence_code, e.title, e.produced_at, e.deleted_at,
             array_agg(distinct coalesce(ci.item_code, rq.requirement_code)) as codes,
             array_agg(distinct coalesce(ci.theme_code, rq.clause_group::text)) as clauses,
             so.id as so_id, so.storage_repository_id, so.external_item_id, so.external_version_id, so.version_label,
             so.display_name, so.mime_type, so.size_bytes::text as size_bytes, so.hash_algorithm, so.hash_value,
             so.hash_source, so.folder_path, so.link_status, so.encryption
      from evidence e
      join evidence_target t on t.evidence_id = e.id and t.management_system_id = ${msId}
        and (t.deleted_at is null or e.deleted_at is not null)
      left join ref.catalogue_item ci on ci.id = t.catalogue_item_id
      left join ref.requirement rq on rq.id = t.requirement_id
      left join storage_object so on so.id = e.storage_object_id
      where e.produced_at is not null
        and (${cycleStart}::date is null or e.produced_at >= ${cycleStart}::date)
        and (e.deleted_at is null or (${cycleStart}::date is not null and e.deleted_at >= ${cycleStart}::date))
      group by e.id, so.id
      order by e.position, e.evidence_code`.execute(trx);
    const clauses = scope.clauses ?? [];
    const codes = scope.codes ?? [];
    const filtered = clauses.length === 0 && codes.length === 0;
    const inScope = (row: { codes: string[]; clauses: string[] }) => {
      if (filtered) return true;
      const rowCodes = row.codes.filter((c): c is string => typeof c === 'string');
      if (codes.some((code) => rowCodes.includes(code))) return true;
      return clauses.some((clause) =>
        row.clauses.includes(clause) || rowCodes.some((code) => code === clause || code.startsWith(`${clause}.`) || code.startsWith(`A.${clause}.`)),
      );
    };
    return rows.filter(inScope).map((row) => ({
      id: row.id,
      code: row.evidence_code,
      title: row.title,
      producedAt: row.produced_at,
      deleted: row.deleted_at !== null,
      requirementCodes: [...new Set(row.codes.filter((c): c is string => typeof c === 'string'))].sort(),
      file:
        row.so_id && row.storage_repository_id && row.external_item_id
          ? {
              id: row.so_id,
              repositoryId: row.storage_repository_id,
              externalItemId: row.external_item_id,
              externalVersionId: row.external_version_id,
              versionLabel: row.version_label,
              displayName: row.display_name,
              mimeType: row.mime_type,
              sizeBytes: row.size_bytes,
              hashAlgorithm: row.hash_algorithm ?? 'none',
              hashValue: row.hash_value,
              hashSource: row.hash_source ?? 'none',
              folderPath: row.folder_path,
              linkStatus: row.link_status ?? 'intact',
              encryption: row.encryption,
            }
          : null,
    }));
  }

  /** The event label or date, with ` (2)`, ` (3)` ... when another pack of the system already uses that folder. */
  private async uniqueLabel(trx: Trx, pack: PackRow, system: SystemRow, base: string): Promise<string> {
    const { rows } = await sql<{ pack_folder: string }>`
      select pack_folder from evidence_pack
      where management_system_id = ${system.id} and id <> ${pack.id} and deleted_at is null and pack_folder is not null`.execute(trx);
    const used = new Set(rows.map((r) => r.pack_folder.split('/').filter((s) => s !== '').pop()));
    if (!used.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const candidate = `${base} (${n})`;
      if (!used.has(candidate)) return candidate;
    }
  }

  // ---------------------------------------------------------------------------------------------- steps 2 and 3

  private async rootPath(input: BuildInput, target: RepositoryTarget): Promise<string> {
    if (target.row.adapter === 'managed_vault') return VAULT_PACK_ROOT;
    const known = input.rootPaths.get(target.row.id);
    if (known !== undefined) return known;
    const config = (target.row.config ?? {}) as { rootFolderId?: string };
    if (!config.rootFolderId) throw new Error(`The repository ${target.row.slug} has no root folder`);
    const listing = await this.gateway.post<ListResponse>('/v1/list', {
      tenant: input.tenant,
      repository: target.descriptor,
      scopeRoot: { folderId: config.rootFolderId, path: '' },
    });
    input.rootPaths.set(target.row.id, listing.path);
    return listing.path;
  }

  /** E.7 step 2: the pack folder of one repository, created where missing; returns its path from the drive root. */
  private async ensureFolder(input: BuildInput, repositoryId: string): Promise<string> {
    const target = input.repositories.get(repositoryId);
    if (!target) throw new Error(`Repository ${repositoryId} is not part of the pack`);
    const path = packFolderPath(await this.rootPath(input, target), input.system.code, input.label);
    const made = await this.gateway.post<EnsureFolderResponse>('/v1/ensure-folder', { tenant: input.tenant, repository: target.descriptor, path });
    return joinFolder(made.path);
  }

  /** E.7 step 3: one copy per intact or moved file into the pack folder of its repository. */
  private async copy(input: BuildInput): Promise<{ folders: Map<string, string>; items: PlannedItem[] }> {
    const folders = new Map<string, string>();
    const folderErrors = new Map<string, string>();
    const items: PlannedItem[] = [];
    for (const evidence of input.evidence) {
      const file = evidence.file;
      if (!file || !COPYABLE_STATUSES.has(file.linkStatus)) {
        items.push({ evidence, copy: null, exception: exceptionReason(file ? file.linkStatus : null) });
        continue;
      }
      if (!folders.has(file.repositoryId) && !folderErrors.has(file.repositoryId)) {
        try {
          folders.set(file.repositoryId, await this.ensureFolder(input, file.repositoryId));
        } catch (error) {
          folderErrors.set(file.repositoryId, errorText(error));
        }
      }
      const folder = folders.get(file.repositoryId);
      if (!folder) {
        items.push({ evidence, copy: null, exception: `The pack folder could not be created: ${folderErrors.get(file.repositoryId)}` });
        continue;
      }
      const target = input.repositories.get(file.repositoryId)!;
      try {
        const result = await this.gateway.post<CopyWithinResult>('/v1/copy-within', {
          tenant: input.tenant,
          repository: target.descriptor,
          objects: [objectRef(file)],
          targetFolderPath: folder,
        });
        const made = result.items[0];
        if (!made) throw new Error('The gateway reported no copy');
        items.push({ evidence, copy: { repositoryId: file.repositoryId, newItemId: made.newItemId, location: made.location, source: file }, exception: null });
      } catch (error) {
        items.push({ evidence, copy: null, exception: `Copy failed: ${errorText(error)}` });
      }
    }
    return { folders, items };
  }

  private manifestItem(item: PlannedItem): ManifestItem {
    const file = item.evidence.file;
    return {
      evidenceCode: item.evidence.code,
      title: item.evidence.title,
      requirementCodes: item.evidence.requirementCodes,
      producedAt: item.evidence.producedAt,
      externalVersionId: file?.externalVersionId ?? null,
      hashAlgorithm: file && file.hashAlgorithm !== 'none' ? file.hashAlgorithm : null,
      hashValue: file?.hashValue ?? null,
      linkStatus: file?.linkStatus ?? null,
      copyLocation: item.copy ? `/${joinFolder(item.copy.location)}` : null,
      deleted: item.evidence.deleted,
      exceptionReason: item.exception,
    };
  }

  // ---------------------------------------------------------------------------------------------- steps 4 and 5

  private scopeRootFor(target: RepositoryTarget, rootPath: string): ScopeRoot {
    if (target.row.adapter === 'managed_vault') return { folderId: null, path: '' };
    const config = (target.row.config ?? {}) as { rootFolderId?: string };
    return { folderId: config.rootFolderId ?? null, path: rootPath };
  }

  /** `PUT /v1/objects` of a manifest or the archive into the pack folder (a path from the drive root). */
  private async put(input: BuildInput, repositoryId: string, folder: string, name: string, body: Buffer | Readable): Promise<StoredPackObject> {
    const target = input.repositories.get(repositoryId)!;
    let rootPath = '';
    let folderPath = folder;
    if (target.row.adapter !== 'managed_vault') {
      rootPath = await this.rootPath(input, target);
      const rootSegments = joinFolder(rootPath).split('/').filter((s) => s !== '');
      const segments = folder.split('/');
      folderPath = segments.slice(rootSegments.length).join('/');
    }
    const header = {
      tenant: input.tenant,
      repository: target.descriptor,
      scopeRoot: this.scopeRootFor(target, rootPath),
      folderPath,
      fileName: name,
      maxBytes: PACK_OBJECT_MAX_BYTES,
      metadataMinimization: target.row.metadata_minimization,
    };
    const stream = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    const result = await this.gateway.putObject<PutResult>(header, stream);
    return { repositoryId, name, result };
  }

  /** E.7 step 5: `.tar.gz` of the vault copies and both manifests, stored next to them. */
  private async archive(input: BuildInput, folder: string, items: readonly PlannedItem[], csv: Buffer, pdf: Buffer): Promise<StoredPackObject> {
    const now = this.clock.now();
    const entries: TarEntry[] = [
      { name: MANIFEST_CSV_NAME, size: csv.length, mtime: now, open: async () => csv },
      { name: MANIFEST_PDF_NAME, size: pdf.length, mtime: now, open: async () => pdf },
    ];
    for (const item of items) {
      const copy = item.copy;
      if (!copy) continue;
      const target = input.repositories.get(copy.repositoryId)!;
      if (target.row.adapter !== 'managed_vault') continue;
      const ref: GatewayObjectRef = { ...objectRef(copy.source), externalItemId: copy.newItemId, externalVersionId: null };
      const name = `evidence/${item.evidence.code}-${copy.source.displayName ?? copy.location.split('/').pop() ?? 'file'}`;
      const request = { tenant: input.tenant, repository: target.descriptor, object: ref };
      const known = copy.source.sizeBytes === null ? null : Number(copy.source.sizeBytes);
      if (known !== null && Number.isSafeInteger(known) && known >= 0) {
        // The plaintext size of a vault object is recorded; its bytes are fetched only when the entry is written.
        entries.push({ name, size: known, mtime: now, open: async () => (await this.gateway.stream(request)).stream as AsyncIterable<Uint8Array> });
      } else {
        const fetched = await this.gateway.stream(request);
        const chunks: Buffer[] = [];
        for await (const chunk of fetched.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        const buffer = Buffer.concat(chunks);
        entries.push({ name, size: buffer.length, mtime: now, open: async () => buffer });
      }
    }
    const gzip = createGzip();
    const tar = tarStream(entries);
    tar.on('error', (error) => gzip.destroy(error));
    tar.pipe(gzip);
    return this.put(input, input.manifestRepositoryId, folder, ARCHIVE_NAME, gzip);
  }

  // ---------------------------------------------------------------------------------------------------- step 6

  private async insertObject(trx: Trx, input: { repositoryId: string; values: Record<string, unknown> }): Promise<string> {
    const row = await trx
      .insertInto('storage_object')
      .values({ storage_repository_id: input.repositoryId, ...(input.values as object) } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  private async complete(trx: Trx, input: BuildInput, items: readonly PlannedItem[], stored: readonly StoredPackObject[], packFolder: string): Promise<EvidencePackBuildResult> {
    const now = this.clock.now();
    const objectIds = new Map<string, string>();
    for (const object of stored) {
      const r = object.result;
      const id = await this.insertObject(trx, {
        repositoryId: object.repositoryId,
        values: {
          external_item_id: r.externalItemId,
          external_version_id: r.externalVersionId,
          version_label: r.versionLabel.slice(0, 30),
          display_name: object.name,
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
        },
      });
      objectIds.set(object.name, id);
    }

    let exceptions = 0;
    for (const item of items) {
      let copyObjectId: string | null = null;
      if (item.copy) {
        const source = item.copy.source;
        copyObjectId = await this.insertObject(trx, {
          repositoryId: item.copy.repositoryId,
          values: {
            external_item_id: item.copy.newItemId,
            external_version_id: null,
            version_label: source.versionLabel,
            display_name: source.displayName ?? item.copy.location.split('/').pop() ?? null,
            mime_type: source.mimeType,
            size_bytes: source.sizeBytes,
            hash_algorithm: source.hashAlgorithm,
            hash_value: source.hashValue,
            hash_source: source.hashSource,
            provider_created_at: now,
            provider_modified_at: now,
            folder_path: `/${locationFolder(joinFolder(item.copy.location))}`,
            encryption: source.encryption && item.copy.repositoryId === source.repositoryId ? JSON.stringify(source.encryption) : null,
            link_status: 'intact',
            link_status_since: now,
            last_verified_at: now,
            last_good_check_at: now,
            created_by: SYSTEM_USER_ID,
            updated_by: SYSTEM_USER_ID,
          },
        });
      }
      if (item.exception) exceptions += 1;
      const manifest = this.manifestItem(item);
      await trx
        .insertInto('evidence_pack_item')
        .values({
          evidence_pack_id: input.pack.id,
          evidence_id: item.evidence.id,
          evidence_code: item.evidence.code,
          requirement_codes: item.evidence.requirementCodes,
          produced_at: item.evidence.producedAt,
          external_version_id: manifest.externalVersionId,
          hash_algorithm: manifest.hashAlgorithm,
          hash_value: manifest.hashValue,
          link_status: manifest.linkStatus,
          copy_location: manifest.copyLocation,
          copy_storage_object_id: copyObjectId,
          is_deleted_record: item.evidence.deleted,
          is_exception: item.exception !== null,
          exception_reason: item.exception,
        })
        .execute();
    }

    await trx
      .updateTable('evidence_pack')
      .set({
        status: 'ready',
        pack_folder: packFolder,
        manifest_csv_object_id: objectIds.get(MANIFEST_CSV_NAME) ?? null,
        manifest_pdf_object_id: objectIds.get(MANIFEST_PDF_NAME) ?? null,
        archive_object_id: objectIds.get(ARCHIVE_NAME) ?? null,
        item_count: items.length,
        exception_count: exceptions,
        built_at: now,
        updated_at: now,
        updated_by: SYSTEM_USER_ID,
      })
      .where('id', '=', input.pack.id)
      .execute();
    const repository = input.repositories.get(input.manifestRepositoryId)!.row;
    const result = { packId: input.pack.id, itemCount: items.length, exceptionCount: exceptions, packFolder, repository: repository.slug };
    if (input.pack.background_task_id) {
      await trx
        .updateTable('background_task')
        .set({ status: 'succeeded', progress: 100, result: JSON.stringify(result), error: null, finished_at: now, updated_at: now })
        .where('id', '=', input.pack.background_task_id)
        .execute();
    }
    await this.audit.record(trx, {
      action: 'evidence_pack.built',
      actor: SYSTEM_ACTOR,
      msId: input.system.id,
      entityType: 'evidence_pack',
      entityId: input.pack.id,
      entityCode: input.label,
      after: { ...result, auditEventId: input.pack.audit_event_id, scope: input.pack.scope, cycleStart: input.cycleStart },
    });
    if (input.pack.created_by) {
      await this.notifications.create(trx, {
        recipientUserId: input.pack.created_by,
        kind: 'evidence_pack_ready',
        msId: input.system.id,
        title: { en: `Evidence pack ${input.label} is ready`, id: `Paket evidence ${input.label} siap` },
        body: {
          en: `${input.system.code}: ${items.length - exceptions} files copied to ${packFolder}, ${exceptions} exceptions.`,
          id: `${input.system.code}: ${items.length - exceptions} berkas disalin ke ${packFolder}, ${exceptions} pengecualian.`,
        },
        ref: { module: 'audit', entityType: 'evidence_pack', id: input.pack.id, code: input.label },
        createdBy: SYSTEM_USER_ID,
      });
    }
    return { packId: input.pack.id, status: 'ready', itemCount: items.length, exceptionCount: exceptions, packFolder };
  }

  private async fail(trx: Trx, input: BuildInput, error: unknown): Promise<void> {
    const now = this.clock.now();
    const text = errorText(error);
    this.logger.error({ packId: input.pack.id, orgId: input.org.id }, `evidence-pack.build failed: ${text}`);
    await trx.updateTable('evidence_pack').set({ status: 'failed', updated_at: now, updated_by: SYSTEM_USER_ID }).where('id', '=', input.pack.id).where('status', '<>', 'ready').execute();
    if (input.pack.background_task_id) {
      await trx
        .updateTable('background_task')
        .set({ status: 'failed', error: text, finished_at: now, updated_at: now })
        .where('id', '=', input.pack.background_task_id)
        .execute();
    }
  }
}
