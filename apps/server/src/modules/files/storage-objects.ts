// `storage_object` rows of new files (build plan C.6, D.5, F.13): from a streamed upload (`PutResult`, SHA-256
// computed by the gateway) or from provider metadata (link and zero-transit, the provider's hash). The stored
// `mime_type` is the gateway's detection only, never a type the browser or the provider declared (F.13).
import type { ObjectMetadata, PutResult } from '@mscd/shared';
import type { Trx } from '../../common/tokens';
import type { RepositoryRow } from '../storage';

export interface NewObject {
  id: string;
  versionLabel: string | null;
  hashAlgorithm: string;
  hashValue: string | null;
  sizeBytes: number | null;
  providerCreatedAt: Date | null;
}

/** Inserts the object of a streamed upload (stored or pass-through). */
export async function insertUploadedObject(
  trx: Trx,
  input: { repository: RepositoryRow; result: PutResult; displayName: string; versionLabel: string; userId: string; now: Date },
): Promise<NewObject> {
  const { result } = input;
  const providerCreatedAt = result.providerCreatedAt ? new Date(result.providerCreatedAt) : input.now;
  const row = await trx
    .insertInto('storage_object')
    .values({
      storage_repository_id: input.repository.id,
      external_item_id: result.externalItemId,
      external_version_id: result.externalVersionId,
      version_label: input.versionLabel.slice(0, 30),
      display_name: input.displayName.slice(0, 255),
      mime_type: result.detectedMimeType.slice(0, 100),
      size_bytes: String(result.sizeBytes),
      hash_algorithm: 'sha256',
      hash_value: result.hashValue,
      hash_source: 'computed',
      provider_created_at: providerCreatedAt,
      provider_modified_at: providerCreatedAt,
      folder_path: result.folderPath,
      web_url: result.webUrl ?? null,
      encryption: result.encryption ? JSON.stringify(result.encryption) : null,
      link_status: 'intact',
      link_status_since: input.now,
      last_verified_at: input.now,
      last_good_check_at: input.now,
      created_by: input.userId,
      updated_by: input.userId,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: row.id, versionLabel: input.versionLabel, hashAlgorithm: 'sha256', hashValue: result.hashValue, sizeBytes: result.sizeBytes, providerCreatedAt };
}

/** Inserts the object of a provider item (link, zero-transit) with its pinned version and provider hash. */
export async function insertProviderObject(
  trx: Trx,
  input: { repository: RepositoryRow; metadata: ObjectMetadata; userId: string; now: Date },
): Promise<NewObject> {
  const m = input.metadata;
  const hashAlgorithm = m.hashValue ? m.hashAlgorithm : 'none';
  const hashSource = hashAlgorithm === 'none' ? 'none' : m.hashSource === 'none' ? 'provider' : m.hashSource;
  const providerCreatedAt = m.providerCreatedAt ? new Date(m.providerCreatedAt) : null;
  const row = await trx
    .insertInto('storage_object')
    .values({
      storage_repository_id: input.repository.id,
      external_item_id: m.externalItemId,
      external_version_id: m.externalVersionId,
      version_label: m.versionLabel ? m.versionLabel.slice(0, 30) : null,
      display_name: m.name.slice(0, 255),
      mime_type: m.detectedMimeType ? m.detectedMimeType.slice(0, 100) : null,
      size_bytes: m.sizeBytes === null ? null : String(m.sizeBytes),
      hash_algorithm: hashAlgorithm,
      hash_value: hashAlgorithm === 'none' ? null : m.hashValue,
      hash_source: hashSource,
      provider_created_at: providerCreatedAt,
      provider_modified_at: m.providerModifiedAt ? new Date(m.providerModifiedAt) : null,
      provider_modified_by: m.modifiedBy ? m.modifiedBy.slice(0, 150) : null,
      folder_path: m.folderPath,
      folder_id: m.folderId,
      web_url: m.webUrl,
      link_status: 'intact',
      link_status_since: input.now,
      last_verified_at: input.now,
      last_good_check_at: input.now,
      created_by: input.userId,
      updated_by: input.userId,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    versionLabel: m.versionLabel,
    hashAlgorithm,
    hashValue: hashAlgorithm === 'none' ? null : m.hashValue,
    sizeBytes: m.sizeBytes,
    providerCreatedAt,
  };
}
