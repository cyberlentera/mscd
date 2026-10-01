// Repository rows as the storage screen and the snapshot show them (build plan D.2 `RepositoryView`, G.5 `REPOS`,
// C.11 repository status). The pure helpers are shared with the read model (WP-17): `repositoryActions` gives the
// card actions, `repositoryModesText` the modes label, `repositoryStatus` the C.11 code.
import type { CredentialKind, OwnershipType, RepoAction, RepositoryView, StorageAdapter, StorageMode, Text } from '@mscd/shared';
import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import { fmtDayTime } from '../../common/dates';
import type { Trx } from '../../common/tokens';
import type { StorageCredentialTable, StorageRepositoryTable } from '../../db/types/tenant-storage';
import type { JsonObject } from '../../db/types';

export type RepositoryRow = Selectable<StorageRepositoryTable>;
export type CredentialRow = Selectable<StorageCredentialTable>;

/** G.5 `REPOS[].type`. */
export const REPOSITORY_TYPE: Readonly<Record<StorageAdapter, string>> = {
  managed_vault: '',
  m365: 'Microsoft 365',
  google_drive: 'Google Workspace',
  smb: 'File share',
  s3: 'S3',
  webdav: 'WebDAV',
};

/** G.5 mode labels (`stored` is the vault's upload). */
export const MODE_LABELS: Readonly<Record<StorageMode, readonly [string, string]>> = {
  stored: ['Upload, versioned, SHA-256', 'Upload, berversi, SHA-256'],
  link: ['Link', 'Link'],
  pass_through: ['Pass-through', 'Pass-through'],
  zero_transit: ['Zero-transit', 'Zero-transit'],
};

/** G.5 `ROUTING[][2]`: the mode label of a routing rule (`stored` gives `Upload`). */
export function routingModeLabel(mode: StorageMode): string {
  return mode === 'stored' ? 'Upload' : MODE_LABELS[mode][0];
}

/** G.5 `REPOS[].modes`: labels joined with `, `; a pair when the labels differ by language. */
export function repositoryModesText(modes: readonly StorageMode[]): Text {
  const en = modes.map((mode) => MODE_LABELS[mode][0]).join(', ');
  const id = modes.map((mode) => MODE_LABELS[mode][1]).join(', ');
  return en === id ? en : [en, id];
}

/**
 * G.5 `REPOS[].actions`: `test` always; `reauthorise` for a Google Drive repository whose credential is a delegated
 * OAuth token; `moveToLibrary` for a personal repository.
 */
export function repositoryActions(input: { adapter: StorageAdapter; ownershipType: OwnershipType; credentialKind: CredentialKind | null }): RepoAction[] {
  const actions: RepoAction[] = ['test'];
  if (input.adapter === 'google_drive' && input.credentialKind === 'oauth_refresh_token') actions.push('reauthorise');
  if (input.ownershipType === 'personal') actions.push('moveToLibrary');
  return actions;
}

/** C.11 repository status: `bad` when the connection is not ok, else `warn` for personal storage, else `ok`. */
export function repositoryStatus(connectionStatus: RepositoryRow['connection_status'], ownershipType: OwnershipType): 'ok' | 'warn' | 'bad' {
  if (connectionStatus !== 'ok') return 'bad';
  return ownershipType === 'personal' ? 'warn' : 'ok';
}

function isText(value: unknown): value is Text {
  return typeof value === 'string' || (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string'));
}

/** G.5 `REPOS[].tenant`: `display.configSummary`, else a summary of the configuration. */
export function repositorySummary(row: Pick<RepositoryRow, 'adapter' | 'config' | 'display'>): Text {
  const display = (row.display ?? {}) as JsonObject;
  if (isText(display.configSummary)) return display.configSummary;
  const config = (row.config ?? {}) as JsonObject;
  switch (row.adapter) {
    case 'managed_vault':
      return ['Encryption per tenant', 'Enkripsi per tenant'];
    case 'm365':
    case 'google_drive':
      return typeof config.driveId === 'string' ? config.driveId : '-';
    default:
      return '-';
  }
}

/** Config without anything secret (the config never holds secrets; this keeps it a plain object). */
function publicConfig(config: unknown): Record<string, unknown> {
  return config && typeof config === 'object' && !Array.isArray(config) ? { ...(config as Record<string, unknown>) } : {};
}

/** The repository view of one row. `ms` are the codes of the systems that use it, in system order. */
export function toRepositoryView(
  row: RepositoryRow,
  credential: Pick<CredentialRow, 'kind' | 'expires_at' | 'config_sha256'> | null,
  context: { ms: string[]; timeZone: string; configSha256: string },
): RepositoryView {
  const credentialSet = credential !== null && credential.config_sha256 === context.configSha256;
  return {
    id: row.slug,
    ref: row.id,
    name: row.name,
    type: REPOSITORY_TYPE[row.adapter],
    status: repositoryStatus(row.connection_status, row.ownership_type),
    ...(row.connection_message_en ? { msg: [row.connection_message_en, row.connection_message_id ?? row.connection_message_en] as [string, string] } : {}),
    tenant: repositorySummary(row),
    ms: context.ms,
    last: fmtDayTime(row.last_checked_at, context.timeZone),
    adapter: row.adapter,
    modes: [...row.modes],
    ownershipType: row.ownership_type,
    connectionStatus: row.connection_status,
    retentionConfirmed: row.retention_confirmed,
    metadataMinimization: row.metadata_minimization,
    readOnly: row.read_only,
    credentialSet,
    credentialExpiresAt: credentialSet && credential?.expires_at ? credential.expires_at.toISOString() : null,
    config: publicConfig(row.config),
    actions: repositoryActions({ adapter: row.adapter, ownershipType: row.ownership_type, credentialKind: credentialSet ? credential!.kind : null }),
  };
}

/** The active (not revoked, not deleted) credential of a repository, by its `credential_ref`. */
export async function activeCredential(trx: Trx, repository: Pick<RepositoryRow, 'id' | 'credential_ref'>): Promise<CredentialRow | null> {
  if (!repository.credential_ref) return null;
  const row = await trx
    .selectFrom('storage_credential')
    .selectAll()
    .where('storage_repository_id', '=', repository.id)
    .where('credential_ref', '=', repository.credential_ref)
    .where('revoked_at', 'is', null)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Codes of the systems that use each repository (G.5 `REPOS[].ms`): its default repository, a routing target
 * (an organisation-wide rule counts for every system), or the storage objects of their evidence. In system order.
 */
export async function repositoryUsage(trx: Trx): Promise<Map<string, string[]>> {
  const systems = await trx
    .selectFrom('management_system')
    .select(['id', 'code', 'default_storage_repository_id'])
    .where('deleted_at', 'is', null)
    .orderBy('position')
    .orderBy('code')
    .execute();
  const rules = await trx
    .selectFrom('storage_routing_rule')
    .select(['storage_repository_id', 'management_system_id'])
    .where('deleted_at', 'is', null)
    .where('approval_status', '=', 'active')
    .execute();
  const evidence = await trx
    .selectFrom('evidence as e')
    .innerJoin('storage_object as o', 'o.id', 'e.storage_object_id')
    .innerJoin('evidence_target as t', 't.evidence_id', 'e.id')
    .select(['o.storage_repository_id as repositoryId', 't.management_system_id as msId'])
    .where('e.deleted_at', 'is', null)
    .where('t.deleted_at', 'is', null)
    .where('o.deleted_at', 'is', null)
    .groupBy(['o.storage_repository_id', 't.management_system_id'])
    .execute();
  const uses = new Map<string, Set<string>>();
  const add = (repositoryId: string, msId: string) => {
    if (!uses.has(repositoryId)) uses.set(repositoryId, new Set());
    uses.get(repositoryId)!.add(msId);
  };
  for (const system of systems) add(system.default_storage_repository_id, system.id);
  for (const rule of rules) {
    if (rule.management_system_id) add(rule.storage_repository_id, rule.management_system_id);
    else for (const system of systems) add(rule.storage_repository_id, system.id);
  }
  for (const row of evidence) add(row.repositoryId, row.msId);
  const result = new Map<string, string[]>();
  for (const [repositoryId, ids] of uses) {
    result.set(
      repositoryId,
      systems.filter((system) => ids.has(system.id)).map((system) => system.code),
    );
  }
  return result;
}

/** Every repository of the transaction's organisation as `RepositoryView`, in card order. */
export async function listRepositoryViews(
  trx: Trx,
  options: { timeZone: string; configSha256: (config: Record<string, unknown>) => string },
): Promise<RepositoryView[]> {
  const rows = await trx.selectFrom('storage_repository').selectAll().where('deleted_at', 'is', null).orderBy('position').orderBy('slug').execute();
  const usage = await repositoryUsage(trx);
  const credentials = await trx
    .selectFrom('storage_credential as c')
    .innerJoin('storage_repository as r', (join) => join.onRef('r.id', '=', 'c.storage_repository_id').onRef('r.credential_ref', '=', 'c.credential_ref'))
    .select(['c.storage_repository_id', 'c.kind', 'c.expires_at', 'c.config_sha256'])
    .where('c.revoked_at', 'is', null)
    .where('c.deleted_at', 'is', null)
    .execute();
  const byRepository = new Map(credentials.map((c) => [c.storage_repository_id, c]));
  return rows.map((row) =>
    toRepositoryView(row, byRepository.get(row.id) ?? null, {
      ms: usage.get(row.id) ?? [],
      timeZone: options.timeZone,
      configSha256: options.configSha256(publicConfig(row.config)),
    }),
  );
}

/** Next position for a new repository card. */
export async function nextRepositoryPosition(trx: Trx): Promise<number> {
  const row = await trx
    .selectFrom('storage_repository')
    .select(sql<number>`coalesce(max(position), -1) + 1`.as('next'))
    .executeTakeFirstOrThrow();
  return Number(row.next);
}
