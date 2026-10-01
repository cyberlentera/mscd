// The E.4 link status precedence (A-06): the new `storage_object.link_status` from a gateway `stat` result. Pure
// functions, shared by the link health check and its tests.
import type { LinkStatus, StatResult, StorageAdapter } from '@mscd/shared';
import { validForStatus, type StorageObjectState } from '../read-model/derive/integrity';

/** The stored facts of a storage object the precedence compares with the provider. */
export interface StoredLinkState extends StorageObjectState {
  externalVersionId: string | null;
  hashValue: string | null;
  folderPath: string | null;
}

export type LinkReason = StorageObjectState['linkStatusReason'];

export interface LinkDecision {
  /** False only for `rate_limited`: nothing about the object changes and the check is rescheduled. */
  checked: boolean;
  status: LinkStatus;
  reason: LinkReason;
  /** The folder path to store, when the provider reports another folder than the stored one (null: keep). */
  folderPath: string | null;
  /** The provider answered with the item (`last_good_check_at` moves). */
  found: boolean;
}

/**
 * A folder path in a comparable form: segments trimmed, empty segments dropped, joined by `/`. The demo data and
 * older records write paths as `Compliance / ISMS / Evidence`, the adapters as `Compliance/ISMS/Evidence`; both
 * name the same folder. Microsoft 365 compares names without regard to case (SharePoint does), so its paths are
 * lower-cased too.
 */
export function normaliseFolderPath(path: string | null | undefined, adapter?: StorageAdapter): string | null {
  if (path === null || path === undefined) return null;
  const joined = path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
  return adapter === 'm365' ? joined.toLowerCase() : joined;
}

/** True when two folder paths name the same folder (see `normaliseFolderPath`). */
export function sameFolder(a: string | null | undefined, b: string | null | undefined, adapter?: StorageAdapter): boolean {
  return normaliseFolderPath(a, adapter) === normaliseFolderPath(b, adapter);
}

/**
 * E.4 precedence:
 * rate_limited leaves everything unchanged; unreachable gives verification_pending (reason credential_invalid or
 * unreachable) unless the current status is already not valid (C.12 at `now`); not_found gives missing; forbidden
 * gives access_denied; a provider hash that differs on the pinned version gives hash_mismatch; another current
 * version gives version_changed (pinned version still there) or pinned_version_lost; another folder gives moved
 * (and stays moved while the item is found where it went); else intact.
 */
export function decideLinkStatus(stored: StoredLinkState, result: StatResult, now: Date, adapter?: StorageAdapter): LinkDecision {
  const keep: LinkDecision = { checked: true, status: stored.linkStatus, reason: stored.linkStatusReason, folderPath: null, found: false };
  switch (result.outcome) {
    case 'rate_limited':
      return { ...keep, checked: false };
    case 'unreachable': {
      if (!validForStatus(stored, now)) return keep;
      return { ...keep, status: 'verification_pending', reason: result.detail === 'credential_invalid' ? 'credential_invalid' : 'unreachable' };
    }
    case 'not_found':
      return { ...keep, status: 'missing', reason: null };
    case 'forbidden':
      return { ...keep, status: 'access_denied', reason: null };
    case 'found':
      break;
  }
  const current = result.current;
  const currentFolder = result.folderPath ?? current?.folderPath ?? null;
  const folderChanged = currentFolder !== null && !sameFolder(currentFolder, stored.folderPath, adapter);
  const found: LinkDecision = { checked: true, status: 'intact', reason: null, folderPath: folderChanged ? currentFolder : null, found: true };
  // A computed hash is compared only by the weekly re-hash (A-08); its finding stays until the file is replaced.
  if (stored.hashSource === 'computed' && stored.linkStatus === 'hash_mismatch') return { ...found, status: 'hash_mismatch' };
  if (!current) return found;
  const sameVersion = (current.externalVersionId ?? null) === (stored.externalVersionId ?? null);
  if (stored.hashSource === 'provider' && sameVersion && stored.hashValue !== null) {
    const providerHash = result.pinnedHash ?? current.hashValue;
    if (providerHash !== null && providerHash !== undefined && providerHash !== stored.hashValue) return { ...found, status: 'hash_mismatch' };
  }
  if (!sameVersion) return { ...found, status: result.pinnedVersionAvailable ? 'version_changed' : 'pinned_version_lost' };
  // A move stays visible until the file is linked again (the stored folder already follows the item).
  if (folderChanged || stored.linkStatus === 'moved') return { ...found, status: 'moved' };
  return found;
}
