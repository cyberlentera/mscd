// What every file route needs (build plan D.3, F.7): the system of the request, the record the file is for (through
// `RecordResolver`, with the own-record check of own grants), the permission of the record kind, the BR-29 inputs,
// the gateway descriptors and the storage object rows.
import { Inject, Injectable } from '@nestjs/common';
import type { GatewayObjectRef, ObjectKind, Permission, RecordRef } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { ForbiddenError, NotFoundError } from '../../common/problems';
import {
  LICENCE_GATE,
  PERMISSION_EVALUATOR,
  RECORD_RESOLVER,
  type LicenceGate,
  type PermissionDecision,
  type PermissionEvaluator,
  type Principal,
  type RecordResolver,
  type ResolvedRecord,
  type TenantInfo,
  type Trx,
} from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { StorageGatewayContext, type RepositoryRow } from '../storage';
import { assertOwner, type AdapterAvailability } from './files-support';

/** A management system as the file routes need it. */
export interface FilesMs {
  id: string;
  slug: string;
  code: string;
}

/** `storage_object` columns the file routes read. */
export interface StorageObjectRow {
  id: string;
  storage_repository_id: string;
  external_item_id: string;
  external_version_id: string | null;
  version_label: string | null;
  display_name: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  hash_algorithm: GatewayObjectRef['hashAlgorithm'];
  hash_value: string | null;
  hash_source: GatewayObjectRef['hashSource'];
  folder_path: string | null;
  provider_created_at: Date | null;
}

/** The permission that submits a file of a record kind (D.3). */
export const SUBMIT_PERMISSION: Readonly<Record<ObjectKind, Permission>> = {
  evidence: 'evidence.file.submit',
  document: 'document.version.create',
};

/** The record ref module of the file records (A-21). */
export function recordRef(kind: ObjectKind, id: string, code: string): RecordRef {
  return { module: 'implementation', entityType: kind, id, code };
}

@Injectable()
export class FilesCommon {
  constructor(
    readonly storage: StorageGatewayContext,
    readonly clock: Clock,
    private readonly config: MscdConfig,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
  ) {}

  org(principal: Principal): TenantInfo {
    if (!principal.org) throw new NotFoundError('No organisation is selected');
    return principal.org;
  }

  /** Today in the organisation's time zone (D-07). */
  today(principal: Principal): string {
    return this.clock.todayIn(this.org(principal).timeZone);
  }

  /** BR-29 inputs: the adapters of this installation and the organisation's licence. */
  adapters(orgId: string): AdapterAvailability {
    return {
      enabled: this.config.profile.storage.adapters.enabled,
      isLicensed: (adapter) => this.licence.isAdapterLicensed(orgId, adapter),
    };
  }

  /** The system with its code (404 when the slug names none). */
  async ms(trx: Trx, slug: string): Promise<FilesMs> {
    const ref = await this.records.resolveMs(trx, slug);
    const row = await trx.selectFrom('management_system').select(['id', 'slug', 'code']).where('id', '=', ref.id).executeTakeFirstOrThrow();
    return row;
  }

  /**
   * The decision for the permission of the record kind in `ms` (the route admits either file permission, D.3): 403
   * when the caller lacks the one this kind needs, `own` when only an own grant gives it.
   */
  async decision(principal: Principal, ms: string, kind: ObjectKind): Promise<Exclude<PermissionDecision, null>> {
    const decision = await this.evaluator.evaluate(principal, SUBMIT_PERMISSION[kind], { scope: 'ms', ms });
    if (!decision) throw new ForbiddenError(`${SUBMIT_PERMISSION[kind]} is needed for this record`);
    return decision;
  }

  /** Whether the caller holds a permission in `ms` at all (any grant). */
  async holds(principal: Principal, ms: string, permission: Permission): Promise<PermissionDecision> {
    return this.evaluator.evaluate(principal, permission, { scope: 'ms', ms });
  }

  /** The record of a file through `RecordResolver` (404 outside `ms`), owned by the caller when the grant is own. */
  async record(trx: Trx, principal: Principal, ms: string, kind: ObjectKind, id: string, own: boolean, options: { forUpdate?: boolean } = {}): Promise<ResolvedRecord> {
    const record = await this.records.resolve(trx, ms, kind, id, options);
    assertOwner(own, record.row.owner_user_id, principal.user.id);
    return record;
  }

  /** The business code of a record (`evidence_code` or `doc_code`). */
  codeOf(record: ResolvedRecord): string {
    const row = record.row as { evidence_code?: string; doc_code?: string };
    return (record.entityType === 'evidence' ? row.evidence_code : row.doc_code) ?? record.id;
  }

  /** A storage object of the organisation (not deleted); 404 when there is none. */
  async object(trx: Trx, id: string): Promise<StorageObjectRow> {
    const row = await trx
      .selectFrom('storage_object')
      .select([
        'id', 'storage_repository_id', 'external_item_id', 'external_version_id', 'version_label', 'display_name', 'mime_type', 'size_bytes',
        'hash_algorithm', 'hash_value', 'hash_source', 'folder_path', 'provider_created_at',
      ])
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFoundError();
    return row;
  }

  /** The repository of an object, deleted repositories included (their files stay readable through the gateway). */
  async repositoryOf(trx: Trx, object: Pick<StorageObjectRow, 'storage_repository_id'>): Promise<RepositoryRow> {
    return trx.selectFrom('storage_repository').selectAll().where('id', '=', object.storage_repository_id).executeTakeFirstOrThrow();
  }

  /** The stored facts of an object that gateway calls compare with the provider (D.5 `GatewayObjectRef`). */
  objectRef(object: StorageObjectRow): GatewayObjectRef {
    return {
      externalItemId: object.external_item_id,
      externalVersionId: object.external_version_id,
      hashAlgorithm: object.hash_algorithm,
      hashValue: object.hash_value,
      hashSource: object.hash_source,
      folderPath: object.folder_path,
    };
  }

  /** Slugs of the systems an evidence record belongs to: its links and the systems of its targets. */
  async evidenceSystems(trx: Trx, evidenceId: string): Promise<{ ids: string[]; slugs: string[] }> {
    const { rows } = await sql<{ id: string; slug: string }>`
      select distinct ms.id, ms.slug, ms.position from management_system ms
       where ms.deleted_at is null
         and (exists (select 1 from entity_ms_link l where l.entity_type = 'evidence' and l.entity_id = ${evidenceId}
                        and l.management_system_id = ms.id and l.deleted_at is null)
              or exists (select 1 from evidence_target t where t.evidence_id = ${evidenceId}
                           and t.management_system_id = ms.id and t.deleted_at is null))
       order by ms.position, ms.slug`.execute(trx);
    return { ids: rows.map((r) => r.id), slugs: rows.map((r) => r.slug) };
  }

  /** Slugs of the systems a document belongs to: its links, every system for organisation-wide documents. */
  async documentSystems(trx: Trx, documentId: string, orgWide: boolean): Promise<string[]> {
    const { rows } = await sql<{ slug: string }>`
      select ms.slug from management_system ms
       where ms.deleted_at is null
         and (${orgWide}::boolean
              or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = ${documentId}
                           and l.management_system_id = ms.id and l.deleted_at is null))
       order by ms.position, ms.slug`.execute(trx);
    return rows.map((r) => r.slug);
  }
}
