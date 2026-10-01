// Integrity of an evidence file (build plan C.12, A-05, A.4 5.3, TS 6.4, TS 5.7). One definition for the read
// model, the commands (BR-01, WP-20) and the jobs (freshness.recompute, link health, drift).
import { uiHashAlg, uiIntegId, type HashAlgorithm, type HashSource, type IntegId, type LinkStatus } from '@mscd/shared';

/** The storage object state these rules read; null for evidence without a storage object (`external_ref`, A-18). */
export interface StorageObjectState {
  linkStatus: LinkStatus;
  hashAlgorithm: HashAlgorithm;
  hashSource: HashSource;
  linkStatusSince: Date;
  linkStatusReason: 'unreachable' | 'credential_invalid' | null;
}

export type IntegrityStatus = 'ok' | 'degraded' | 'broken';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How long a `verification_pending` link stays valid: 7 days, 72 hours when the credential is invalid (TS 5.7). */
export function pendingWindowMs(reason: StorageObjectState['linkStatusReason']): number {
  return reason === 'credential_invalid' ? 72 * HOUR_MS : 7 * DAY_MS;
}

/** How long an `access_denied` link stays valid (C.12): 72 hours. */
export const ACCESS_DENIED_WINDOW_MS = 72 * HOUR_MS;

/** UI integrity codes that "cannot be verified" lists show (A.4 5.3, UI 2.1); `chain()` uses the same set. */
export const UNVERIFIABLE_INTEG: readonly IntegId[] = ['missing', 'revoked', 'changed', 'moved'];

/** C.12 UI code of an evidence file; `ok` without a storage object. */
export function integOf(object: StorageObjectState | null): IntegId {
  return uiIntegId(object);
}

/** True for the integrity codes of "cannot be verified" (UI 2.1 `bad`). */
export function isUnverifiable(integ: IntegId): boolean {
  return UNVERIFIABLE_INTEG.includes(integ);
}

/** True when the file is missing or access was revoked (chain item `missing` flag, UI 2.1). */
export function isMissingFile(integ: IntegId): boolean {
  return integ === 'missing' || integ === 'revoked';
}

/** C.12 `hashAlg` text; `none` without a storage object. */
export function hashAlgText(object: Pick<StorageObjectState, 'hashAlgorithm' | 'hashSource'> | null): string {
  return object ? uiHashAlg(object.hashAlgorithm, object.hashSource) : 'none';
}

function within(since: Date, windowMs: number, now: Date): boolean {
  return now.getTime() - since.getTime() <= windowMs;
}

/**
 * C.12 "valid for status logic" (TS 6.4): intact, moved and version_changed are valid; verification_pending for 7
 * days from `link_status_since` (72 hours when the credential is invalid); access_denied for 72 hours; hash
 * mismatch, missing and a lost pinned version are not. Evidence without a storage object is valid.
 */
export function validForStatus(object: StorageObjectState | null, now: Date): boolean {
  if (!object) return true;
  switch (object.linkStatus) {
    case 'intact':
    case 'moved':
    case 'version_changed':
      return true;
    case 'verification_pending':
      return within(object.linkStatusSince, pendingWindowMs(object.linkStatusReason), now);
    case 'access_denied':
      return within(object.linkStatusSince, ACCESS_DENIED_WINDOW_MS, now);
    case 'hash_mismatch':
    case 'missing':
    case 'pinned_version_lost':
      return false;
  }
}

/** BR-01 v2.0 (TS 6.1): no storage object, or the link is intact or moved. */
export function br01LinkOk(object: Pick<StorageObjectState, 'linkStatus'> | null): boolean {
  return !object || object.linkStatus === 'intact' || object.linkStatus === 'moved';
}

/**
 * A-05 `integrity_status`: `ok` for intact and moved (with a content hash); `degraded` for version_changed,
 * verification_pending inside its window, access_denied inside 72 hours, and files without a content hash
 * (`hash_source = 'none'`); `broken` otherwise. Evidence without a storage object is `ok` (A-18).
 */
export function integrityStatus(object: StorageObjectState | null, now: Date): IntegrityStatus {
  if (!object) return 'ok';
  switch (object.linkStatus) {
    case 'intact':
    case 'moved':
      return object.hashSource === 'none' ? 'degraded' : 'ok';
    case 'version_changed':
      return 'degraded';
    case 'verification_pending':
      return within(object.linkStatusSince, pendingWindowMs(object.linkStatusReason), now) ? 'degraded' : 'broken';
    case 'access_denied':
      return within(object.linkStatusSince, ACCESS_DENIED_WINDOW_MS, now) ? 'degraded' : 'broken';
    case 'hash_mismatch':
    case 'missing':
    case 'pinned_version_lost':
      return 'broken';
  }
}
