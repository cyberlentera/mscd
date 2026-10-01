// Pack verification of the server (E.8 steps 1 to 3): `verifyPack` of @mscd/pack-tools (archive rules, signature with
// the compiled pack keys, checksums, every dataset and the references a pack can check alone), then the checks that
// need the server: the engine version and the chain entity types of C.10.
import { compareSemver } from '@mscd/shared';
import { PackError, verifyPack, type VerifiedPack } from '@mscd/pack-tools';
import type { TrustAnchors } from '../license/trust-anchors';

/** Tables that hold chain records (C.9 "Chain records", C.10): the only entity types a chain stage may name. */
export const CHAIN_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'context_issue', 'risk', 'risk_treatment', 'metric', 'quality_objective', 'prioritized_activity',
  'business_impact_analysis', 'exercise', 'business_associate', 'chain_record',
]);

/** Why a pack is refused before anything is written, and the HTTP status of the refusal (D.3). */
export type PackRejectionCode =
  | 'archive' | 'manifest' | 'signature' | 'untrusted_key' | 'rejected_key' | 'checksum' | 'dataset'
  | 'reference' | 'engine_version' | 'downgrade' | 'incompatible';

/**
 * A pack refused in E.8 steps 1 to 4. `status` is 400 for a bad archive, signature, checksum or content, 422 for an
 * engine version the server does not meet, a downgrade, or an edition update the installed data cannot take.
 */
export class PackRejectedError extends Error {
  readonly status: 400 | 422;

  constructor(
    readonly code: PackRejectionCode,
    message: string,
    readonly issues: readonly string[] = [],
    readonly pack: { packId: string; version: string } | null = null,
  ) {
    super(message);
    this.name = 'PackRejectedError';
    this.status = code === 'engine_version' || code === 'downgrade' || code === 'incompatible' ? 422 : 400;
  }
}

/** First line of an error message (pack-tools appends the issue list to the message). */
function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}

/**
 * E.8 steps 1 to 3 for a pack archive. Throws `PackRejectedError`; returns the verified pack with its typed rows.
 * Nothing is read from or written to the database.
 */
export function verifyPackForServer(bytes: Buffer, trust: TrustAnchors, serverVersion: string): VerifiedPack {
  let verified: VerifiedPack;
  try {
    verified = verifyPack(bytes, trust.keys, { rejectKeyIds: trust.rejectKeyIds });
  } catch (error) {
    if (error instanceof PackError) {
      const code = error.code === 'source' || error.code === 'signing_key' ? 'archive' : error.code;
      throw new PackRejectedError(code, firstLine(error.message), error.issues);
    }
    throw new PackRejectedError('archive', `the pack cannot be read: ${(error as Error).message}`);
  }
  const manifest = verified.manifest;
  const pack = { packId: manifest.pack_id, version: manifest.pack_version };
  if (compareSemver(serverVersion.replace(/\+.*$/, ''), manifest.engine_min_version) < 0) {
    throw new PackRejectedError(
      'engine_version',
      `pack ${manifest.pack_id} ${manifest.pack_version} needs server version ${manifest.engine_min_version} or later; this server is ${serverVersion}`,
      [],
      pack,
    );
  }
  const issues: string[] = [];
  for (const stage of verified.datasets.chain) {
    if (stage.entity_type !== null && !CHAIN_ENTITY_TYPES.has(stage.entity_type)) {
      issues.push(`chain.csv: stage ${stage.stage_key} names entity type ${stage.entity_type}, which is not a chain record table (C.10)`);
    }
  }
  if (issues.length > 0) {
    throw new PackRejectedError('reference', `pack ${manifest.pack_id} ${manifest.pack_version} refers to unknown tables`, issues, pack);
  }
  return verified;
}

/** True when `version` is a semantic version the semver compare accepts. */
export function isComparableVersion(version: string): boolean {
  try {
    compareSemver(version, version);
    return true;
  } catch {
    return false;
  }
}
