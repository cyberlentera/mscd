// Signed anchors of the audit chains (build plan D-33, F.11). The anchor job (WP-22) signs the head of each chain
// with the worker's Ed25519 key `audit-anchor.key`: payload `{chain, seq, rowHash, anchoredAt, installationId}` as
// canonical JSON (keys sorted, no white space). A signed line carries the payload members plus `keyId` and
// `signature` (`ed25519:<base64>`), so anyone with `audit-anchor.pub` can verify it offline: remove `keyId` and
// `signature`, take the canonical JSON of the rest, verify the signature. This module holds the helpers both sides
// use; the trusted anchor keys are compiled into the build (D-16).
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@mscd/shared';
import { TRUSTED_KEYS, type TrustedKey } from '../../generated/build-info';

/** What an anchor signs (F.11). `rowHash` is lower-case hex, `anchoredAt` an ISO 8601 UTC instant. */
export interface AnchorPayload {
  chain: string;
  seq: number;
  rowHash: string;
  anchoredAt: string;
  installationId: string;
}

/** One signed anchor as `GET /admin/audit-trail/anchors` returns it (one NDJSON line). */
export interface SignedAnchor extends AnchorPayload {
  keyId: string;
  signature: string;
}

/** A `platform.audit_anchor` row as the verifier reads it. */
export interface AnchorRow {
  chain: string;
  seq: string | number;
  row_hash: Buffer;
  payload: unknown;
  signature: string;
  key_id: string;
}

/** Key id of E.8: first 16 hex characters of the SHA-256 of the public key in DER (SPKI) form. */
export function anchorKeyId(publicKey: KeyObject | string): string {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** The exact bytes an anchor signature covers. */
export function anchorSigningText(payload: AnchorPayload): string {
  return canonicalJson({
    chain: payload.chain,
    seq: payload.seq,
    rowHash: payload.rowHash,
    anchoredAt: payload.anchoredAt,
    installationId: payload.installationId,
  });
}

/** Signs an anchor payload with an Ed25519 private key (the anchor job; tests). */
export function signAnchor(payload: AnchorPayload, privateKey: KeyObject, publicKey: KeyObject): SignedAnchor {
  const signature = sign(null, Buffer.from(anchorSigningText(payload), 'utf8'), privateKey);
  return { ...payload, keyId: anchorKeyId(publicKey), signature: `ed25519:${signature.toString('base64')}` };
}

/** Anchor public keys compiled into this build (`TRUSTED_KEYS` of kind `anchor`, D-16). */
export function compiledAnchorKeys(): readonly TrustedKey[] {
  return TRUSTED_KEYS.filter((key) => key.kind === 'anchor');
}

/** True when the signature of a signed anchor verifies with a trusted anchor key of the same key id. */
export function verifyAnchorSignature(anchor: SignedAnchor, trustedKeys: readonly Pick<TrustedKey, 'keyId' | 'publicKeyPem'>[]): boolean {
  const match = /^ed25519:([A-Za-z0-9+/]{86}==)$/.exec(anchor.signature);
  if (!match) return false;
  const key = trustedKeys.find((k) => k.keyId === anchor.keyId);
  if (!key) return false;
  try {
    return verify(null, Buffer.from(anchorSigningText(anchor), 'utf8'), createPublicKey(key.publicKeyPem), Buffer.from(match[1]!, 'base64'));
  } catch {
    return false;
  }
}

function isPayload(value: unknown): value is AnchorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.chain === 'string' &&
    typeof p.seq === 'number' &&
    typeof p.rowHash === 'string' &&
    typeof p.anchoredAt === 'string' &&
    typeof p.installationId === 'string'
  );
}

/** The signed line of a stored anchor, or null when the row's payload does not match its columns. */
export function signedAnchorOf(row: AnchorRow): SignedAnchor | null {
  if (!isPayload(row.payload)) return null;
  const payload = row.payload;
  if (payload.chain !== row.chain || String(payload.seq) !== String(row.seq) || payload.rowHash !== row.row_hash.toString('hex')) return null;
  return {
    chain: payload.chain,
    seq: payload.seq,
    rowHash: payload.rowHash,
    anchoredAt: payload.anchoredAt,
    installationId: payload.installationId,
    keyId: row.key_id,
    signature: row.signature,
  };
}

/** F.11 anchor verification of a stored row: consistent payload and a valid signature by a trusted key. */
export function verifyAnchorRow(row: AnchorRow, trustedKeys: readonly Pick<TrustedKey, 'keyId' | 'publicKeyPem'>[] = compiledAnchorKeys()): boolean {
  const signed = signedAnchorOf(row);
  return signed !== null && verifyAnchorSignature(signed, trustedKeys);
}
