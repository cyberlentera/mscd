// Repository browse and uploads (build plan D.3 file routes, D.5, F.13, TS 4.5, TS 5.3): the picker listing below
// the system's root folder, upload intents (repository and mode from the routing rules, stored name per metadata
// minimisation, size limit, correlation code), the streamed content of stored and pass-through uploads, and the
// registration of zero-transit uploads. Gateway calls run outside the database transactions; a Google Drive version
// is pinned before the object is recorded, so no row lock is held across a gateway call.
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import {
  uiHashAlg,
  type BrowseQuery,
  type GatewayObjectRef,
  type GatewayRepository,
  type GatewayTenant,
  type ListResponse,
  type ObjectKind,
  type ObjectMetadata,
  type PickerListing,
  type PinVersionResult,
  type PutHeader,
  type ScopeRoot,
  type UploadIntent,
  type UploadIntentRequest,
  type UploadMode,
  type UploadResult,
} from '@mscd/shared';
import type { FastifyRequest } from 'fastify';
import { fmtDay, localDate } from '../../common/dates';
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from '../../common/problems';
import { GATEWAY_CLIENT, type GatewayClient, type Principal, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { RoutingService, type RepositoryRow } from '../storage';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { FilesCommon, type FilesMs } from './files-common';
import {
  assertRepositoryUsable,
  correlationCode,
  joinPath,
  refusal,
  scopeRootOf,
  storedFileName,
  uploadFolder,
  viaGateway,
} from './files-support';
import { GatewayUpload } from './gateway-upload';
import { insertProviderObject, insertUploadedObject, providerObjectRef, uploadedObjectRef } from './storage-objects';

/** Upload intents stay open this long (cleanup.expired marks them expired afterwards, E.2). */
export const INTENT_TTL_MS = 60 * 60 * 1000;
/** At most this many listing pages are read for one picker request. */
const MAX_LIST_PAGES = 10;
const UPLOAD_MODES: readonly UploadMode[] = ['stored', 'pass_through', 'zero_transit'];

/** `upload_intent` columns the upload routes read. */
interface IntentRow {
  id: string;
  created_at: Date;
  created_by: string | null;
  management_system_id: string;
  object_kind: ObjectKind;
  target_id: string;
  storage_repository_id: string;
  mode: UploadMode;
  folder_path: string;
  stored_name: string;
  max_bytes: string;
  correlation_code: string;
  status: 'open' | 'uploaded' | 'completed' | 'expired' | 'failed';
  storage_object_id: string | null;
  expires_at: Date;
}

/** Everything a gateway call of an intent needs, read in one transaction. */
interface IntentCall {
  intent: IntentRow;
  ms: FilesMs;
  repository: RepositoryRow;
  tenant: GatewayTenant;
  descriptor: GatewayRepository;
  scopeRoot: ScopeRoot;
}

/** The upload mode of a routing decision: the rule's mode, or the repository's first upload mode for a link rule. */
export function uploadModeOf(mode: string, repository: Pick<RepositoryRow, 'modes'>): UploadMode | null {
  if ((UPLOAD_MODES as readonly string[]).includes(mode) && (repository.modes as readonly string[]).includes(mode)) return mode as UploadMode;
  return (repository.modes.find((m) => (UPLOAD_MODES as readonly string[]).includes(m)) as UploadMode | undefined) ?? null;
}

/** The size of a request body from `Content-Length`, or null when the client streams without one. */
function contentLengthOf(request: FastifyRequest): number | null {
  const header = request.headers['content-length'];
  if (typeof header !== 'string' || !/^\d{1,16}$/.test(header)) return null;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : null;
}

/** `x / y / z` as the picker shows a folder (UI 1.15). */
function displayPath(path: string): string {
  return path.split('/').filter((s) => s !== '').join(' / ');
}

@Injectable()
export class UploadsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly common: FilesCommon,
    private readonly routing: RoutingService,
    private readonly upload: GatewayUpload,
    private readonly config: MscdConfig,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // GET /storage/repositories/{slug}/browse
  // ---------------------------------------------------------------------------------------------------------------

  /** Files below the system's root folder, for a record the caller may submit a file to (BR-29). */
  async browse(principal: Principal, slug: string, query: BrowseQuery): Promise<PickerListing> {
    const org = this.common.org(principal);
    const decision = await this.common.decision(principal, query.ms, query.kind);
    const prepared = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const ms = await this.common.ms(trx, query.ms);
      await this.common.record(trx, principal, query.ms, query.kind, query.recordId, decision === 'own');
      const repository = await this.common.storage.repositoryBySlug(trx, slug);
      const scopeRoot = scopeRootOf(repository, ms);
      await assertRepositoryUsable(repository, this.common.adapters(org.id));
      return {
        repository,
        scopeRoot,
        tenant: await this.common.storage.tenant(trx, org.id),
        descriptor: await this.common.storage.repository(trx, repository),
      };
    });
    const { repository, scopeRoot, tenant, descriptor } = prepared;
    const items: ObjectMetadata[] = [];
    let path = joinPath(scopeRoot.path, query.path);
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const body = { tenant, repository: descriptor, scopeRoot, ...(query.path ? { folderPath: query.path } : {}), ...(pageToken ? { pageToken } : {}) };
      const result = await viaGateway(repository, () => this.gateway.post<ListResponse>('/v1/list', body));
      path = result.path || path;
      items.push(...result.items);
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    const timeZone = org.timeZone;
    return {
      path: displayPath(path),
      files: items.map((item) => {
        const instant = item.providerModifiedAt ?? item.providerCreatedAt;
        return [
          item.name,
          instant ? fmtDay(localDate(new Date(instant), timeZone)) : '-',
          item.versionLabel ?? '-',
          item.hashValue ? uiHashAlg(item.hashAlgorithm, item.hashSource) : 'none',
          item.modifiedBy ?? '-',
        ];
      }),
      refs: items.map((item) => ({
        repositoryId: repository.slug,
        externalItemId: item.externalItemId,
        ...(item.externalVersionId ? { externalVersionId: item.externalVersionId } : {}),
      })),
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // POST /storage/upload-intents
  // ---------------------------------------------------------------------------------------------------------------

  async createIntent(principal: Principal, body: UploadIntentRequest): Promise<UploadIntent> {
    const org = this.common.org(principal);
    const decision = await this.common.decision(principal, body.ms, body.kind);
    const limit = this.config.profile.storage.max_upload_bytes;
    if (body.size > limit) throw new PayloadTooLargeError(`The file is larger than the upload limit of ${limit} bytes`);
    const today = this.common.today(principal);
    const now = this.common.clock.now();
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const ms = await this.common.ms(trx, body.ms);
      const record = await this.common.record(trx, principal, body.ms, body.kind, body.recordId, decision === 'own');
      const classification = (record.row.classification as 'public' | 'internal' | 'confidential' | 'restricted' | undefined) ?? null;
      const routed = await this.routing.resolve(trx, { msId: ms.id, classification, objectKind: body.kind });
      const repository = routed.repository;
      const mode = uploadModeOf(routed.mode, repository);
      if (!mode) {
        throw refusal('files.no_upload_mode', {
          en: `Repository ${repository.name} only links existing files; choose a file from the repository instead.`,
          id: `Repositori ${repository.name} hanya menautkan berkas yang ada; pilih berkas dari repositori.`,
        });
      }
      await assertRepositoryUsable(repository, this.common.adapters(org.id));
      const scopeRoot = scopeRootOf(repository, ms);
      const code = this.common.codeOf(record);
      const sequence = await this.nextSequence(trx, body.kind, record.id, record.row);
      const minimise = repository.metadata_minimization;
      const storedName = storedFileName({ minimise, code, sequence, fileName: body.fileName });
      const folder = uploadFolder(body.kind, today);
      const correlation = correlationCode(code, randomBytes(4).toString('hex'));
      const expiresAt = new Date(now.getTime() + INTENT_TTL_MS);
      const row = await trx
        .insertInto('upload_intent')
        .values({
          management_system_id: ms.id,
          object_kind: body.kind,
          target_id: record.id,
          storage_repository_id: repository.id,
          mode,
          folder_path: folder,
          stored_name: storedName,
          original_name: minimise ? null : body.fileName,
          max_bytes: String(Math.max(1, body.size)),
          correlation_code: correlation,
          expires_at: expiresAt,
          created_by: principal.user.id,
          updated_by: principal.user.id,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      return {
        intentId: row.id,
        mode,
        repository: { slug: repository.slug, name: repository.name, adapter: repository.adapter },
        ...(mode === 'zero_transit' ? {} : { contentUrl: `/api/v1/storage/upload-intents/${row.id}/content` }),
        maxBytes: Math.max(1, body.size),
        expiresAt: expiresAt.toISOString(),
        correlationCode: correlation,
        folderPath: joinPath(scopeRoot.path, folder),
      };
    });
  }

  /** The file sequence of the next file of a record: evidence `file_sequence + 1`, documents the version count + 1. */
  private async nextSequence(trx: Trx, kind: ObjectKind, id: string, row: Record<string, unknown>): Promise<number> {
    if (kind === 'evidence') return Number(row.file_sequence ?? 0) + 1;
    const counted = await trx.selectFrom('document_version').select((eb) => eb.fn.countAll<string>().as('n')).where('document_id', '=', id).executeTakeFirstOrThrow();
    return Number(counted.n) + 1;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // PUT /storage/upload-intents/{id}/content
  // ---------------------------------------------------------------------------------------------------------------

  /** Streams the request body to the gateway (stored and pass-through intents of the caller). */
  async putContent(principal: Principal, id: string, request: FastifyRequest): Promise<UploadResult> {
    const body = request.body;
    if (!(body instanceof Readable)) {
      throw new ValidationError([{ path: 'body', message: 'Send the file as application/octet-stream' }]);
    }
    const length = contentLengthOf(request);
    const call = await this.intentCall(principal, id, ['stored', 'pass_through'], (intent) => {
      if (length !== null && length > Number(intent.max_bytes)) throw new PayloadTooLargeError(`The file is larger than the ${intent.max_bytes} bytes of the upload intent`);
    });
    const { intent, repository, tenant, descriptor, scopeRoot } = call;
    const header: PutHeader = {
      tenant,
      repository: descriptor,
      scopeRoot,
      folderPath: intent.folder_path,
      fileName: intent.stored_name,
      maxBytes: Number(intent.max_bytes),
      metadataMinimization: repository.metadata_minimization,
    };
    const result = await viaGateway(repository, () => this.upload.put(header, body, length));
    const object = await this.finishUpload(principal, call, uploadedObjectRef(result), async (trx, now) => {
      const sequence = await this.labelSequence(trx, intent);
      const label = repository.adapter === 'managed_vault' ? `v${sequence}` : result.versionLabel;
      return insertUploadedObject(trx, { repository, result, displayName: intent.stored_name, versionLabel: label, userId: principal.user.id, now });
    });
    return {
      storageObjectId: object.id,
      hashAlgorithm: 'sha256',
      hashValue: object.hashValue,
      sizeBytes: result.sizeBytes,
      versionLabel: object.versionLabel ?? '-',
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // POST /storage/upload-intents/{id}/complete
  // ---------------------------------------------------------------------------------------------------------------

  /** Registers a zero-transit upload: the gateway checks folder, creation time, creator and correlation code (D.5). */
  async complete(principal: Principal, id: string, externalItemId: string): Promise<UploadResult> {
    const call = await this.intentCall(principal, id, ['zero_transit']);
    const { intent, repository, tenant, descriptor, scopeRoot } = call;
    const metadata = await viaGateway(
      repository,
      () =>
        this.gateway.post<ObjectMetadata>('/v1/register-client-upload', {
          tenant,
          repository: descriptor,
          scopeRoot,
          externalItemId,
          intent: {
            folderPath: joinPath(scopeRoot.path, intent.folder_path),
            notBefore: intent.created_at.toISOString(),
            correlationCode: intent.correlation_code,
            creatorEmail: principal.user.email,
          },
        }),
      { notFound: 'business-rule', forbidden: 'business-rule' },
    );
    const object = await this.finishUpload(principal, call, providerObjectRef(metadata), (trx, now) => insertProviderObject(trx, { repository, metadata, userId: principal.user.id, now }));
    return {
      storageObjectId: object.id,
      hashAlgorithm: object.hashAlgorithm as UploadResult['hashAlgorithm'],
      hashValue: object.hashValue,
      sizeBytes: object.sizeBytes ?? 0,
      versionLabel: object.versionLabel ?? '-',
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Shared steps of the intent routes
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Reads an open intent of the caller with everything its gateway call needs: 404 for another user's intent, 409
   * when it is no longer open, has expired or has another mode; the record must still exist and the repository must
   * still be usable (BR-29).
   */
  private async intentCall(principal: Principal, id: string, modes: readonly UploadMode[], check?: (intent: IntentRow) => void): Promise<IntentCall> {
    const org = this.common.org(principal);
    const now = this.common.clock.now();
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const intent = await this.intent(trx, id, principal.user.id);
      if (intent.status !== 'open') throw new ConflictError('The upload intent is not open', { messageKey: 'files.intent_not_open' });
      if (intent.expires_at.getTime() <= now.getTime()) throw new ConflictError('The upload intent has expired', { messageKey: 'files.intent_expired' });
      if (!modes.includes(intent.mode)) throw new ConflictError(`The upload intent is for mode ${intent.mode}`, { messageKey: 'files.intent_mode' });
      check?.(intent);
      const msRow = await trx.selectFrom('management_system').select(['id', 'slug', 'code']).where('id', '=', intent.management_system_id).executeTakeFirstOrThrow();
      // The record must still exist in the system (RecordResolver, 404 otherwise).
      await this.common.record(trx, principal, msRow.slug, intent.object_kind, intent.target_id, false);
      const repository = await this.common.storage.repositoryRow(trx, intent.storage_repository_id);
      await assertRepositoryUsable(repository, this.common.adapters(org.id));
      return {
        intent,
        ms: msRow,
        repository,
        tenant: await this.common.storage.tenant(trx, org.id),
        descriptor: await this.common.storage.repository(trx, repository),
        scopeRoot: scopeRootOf(repository, msRow),
      };
    });
  }

  /** The caller's intent (404 for anyone else's, D.3 "creator of the intent"). */
  private async intent(trx: Trx, id: string, userId: string, forUpdate = false): Promise<IntentRow> {
    let query = trx
      .selectFrom('upload_intent')
      .select([
        'id', 'created_at', 'created_by', 'management_system_id', 'object_kind', 'target_id', 'storage_repository_id', 'mode', 'folder_path',
        'stored_name', 'max_bytes', 'correlation_code', 'status', 'storage_object_id', 'expires_at',
      ])
      .where('id', '=', id)
      .where('created_by', '=', userId)
      .where('deleted_at', 'is', null);
    if (forUpdate) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new NotFoundError('No such upload intent');
    return row;
  }

  /** The sequence a vault upload is labelled with (`v<file_sequence>`; an evidence relink re-labels it with the kept sequence). */
  private async labelSequence(trx: Trx, intent: IntentRow): Promise<number> {
    if (intent.object_kind === 'evidence') {
      const row = await trx.selectFrom('evidence').select('file_sequence').where('id', '=', intent.target_id).executeTakeFirst();
      return (row?.file_sequence ?? 0) + 1;
    }
    const counted = await trx.selectFrom('document_version').select((eb) => eb.fn.countAll<string>().as('n')).where('document_id', '=', intent.target_id).executeTakeFirstOrThrow();
    return Number(counted.n) + 1;
  }

  /**
   * After the gateway stored or registered the file: pins the version on Google Drive (keepForever) before any
   * transaction opens, then records the object and marks the intent `uploaded` when it is still open (409 when
   * another request finished it first). A pin whose recording then fails leaves only a kept provider revision.
   */
  private async finishUpload<T extends { id: string }>(
    principal: Principal,
    call: IntentCall,
    ref: GatewayObjectRef,
    insert: (trx: Trx, now: Date) => Promise<T>,
  ): Promise<T> {
    if (call.repository.adapter === 'google_drive') await this.pin(call, ref);
    const now = this.common.clock.now();
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const intent = await this.intent(trx, call.intent.id, principal.user.id, true);
      if (intent.status !== 'open') throw new ConflictError('The upload intent is not open', { messageKey: 'files.intent_not_open' });
      const object = await insert(trx, now);
      await trx
        .updateTable('upload_intent')
        .set({ status: 'uploaded', storage_object_id: object.id, updated_at: now, updated_by: principal.user.id })
        .where('id', '=', intent.id)
        .execute();
      return object;
    });
  }

  /** Google Drive keeps the pinned revision (`keepForever`); other adapters answer `unsupported`, which is fine. */
  private async pin(call: Pick<IntentCall, 'repository' | 'tenant' | 'descriptor'>, ref: GatewayObjectRef): Promise<void> {
    await viaGateway(call.repository, () =>
      this.gateway.post<PinVersionResult>('/v1/pin-version', { tenant: call.tenant, repository: call.descriptor, object: ref }),
    );
  }
}
