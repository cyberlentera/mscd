// Repository credentials (build plan D-08, D.5 "Credential binding", F.11). A credential is sealed by the gateway
// with the tenant data key in the SecretBox format, with additional data
// `cred:<orgId>:<repositoryId>:<sha256 of canonicalJson(config without display fields)>`. On every call the gateway
// recomputes that binding from the call's tenant and repository descriptor, so a sealed blob opens only for the
// organisation, repository and configuration (site, drive, root folder, per-system roots) it was sealed for. The
// api stores the sealed blob and never sees the secret.
import { createHash } from 'node:crypto';
import { canonicalJson, credentialAad, credentialBindingConfig, type CredentialKind } from '@mscd/shared';
import { openWithKek, parseSealed, sealWithKek } from '../../modules/keys/file-key-provider';
import { forbidden } from '../problems';
import type { DataKey } from './data-keys';

/** SHA-256 (hex) of the binding part of a repository config (D-08). */
export function configSha256(config: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(credentialBindingConfig(config)), 'utf8').digest('hex');
}

/** A credential opened for one call. Held in memory for the call only. */
export interface OpenedCredential {
  ref: string;
  kind: CredentialKind;
  secret: Record<string, unknown>;
}

export interface SealedCredentialResult {
  sealedBlob: string;
  /** Id of the tenant data key that sealed it. */
  keyId: string;
  configSha256: string;
}

/** Seals a secret for one organisation, repository and configuration. */
export function sealCredential(
  dataKey: DataKey,
  repository: { id: string; config: Readonly<Record<string, unknown>> },
  kind: CredentialKind,
  secret: Readonly<Record<string, unknown>>,
): SealedCredentialResult {
  const hash = configSha256(repository.config);
  const plain = Buffer.from(JSON.stringify({ kind, secret }), 'utf8');
  try {
    return { sealedBlob: sealWithKek(dataKey.key, plain, credentialAad(dataKey.orgId, repository.id, hash)), keyId: dataKey.id, configSha256: hash };
  } finally {
    plain.fill(0);
  }
}

/**
 * Opens a sealed credential for a call. The binding is recomputed from the call's organisation, repository id and
 * config; any difference (another organisation, repository, drive, site or root) is 403 `credential-binding`.
 */
export function openCredential(
  dataKey: DataKey,
  repository: { id: string; config: Readonly<Record<string, unknown>> },
  credential: { ref: string; sealedBlob: string; kind: CredentialKind },
): OpenedCredential {
  const parsed = parseSealed(credential.sealedBlob);
  if (!parsed) throw forbidden('The repository credential is not a sealed value', 'credential-binding');
  if (parsed.kekId !== dataKey.id) {
    throw forbidden('The repository credential was sealed with another tenant data key', 'credential-binding');
  }
  let plain: Buffer;
  try {
    plain = openWithKek(dataKey.key, credential.sealedBlob, credentialAad(dataKey.orgId, repository.id, configSha256(repository.config)));
  } catch {
    throw forbidden(
      'The repository credential is bound to another organisation, repository or configuration; set the credential again',
      'credential-binding',
    );
  }
  try {
    const value = JSON.parse(plain.toString('utf8')) as { kind?: unknown; secret?: unknown };
    if (value.kind !== credential.kind || value.secret === null || typeof value.secret !== 'object' || Array.isArray(value.secret)) {
      throw forbidden('The repository credential is not of the kind the call names', 'credential-kind');
    }
    return { ref: credential.ref, kind: credential.kind, secret: value.secret as Record<string, unknown> };
  } finally {
    plain.fill(0);
  }
}
