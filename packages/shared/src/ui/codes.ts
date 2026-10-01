// Mappings between database values and the UI codes of `/ui/*` (build plan C.11, C.12, D-13). Pure functions, so
// the read model (WP-17), the per-screen endpoints (WP-32) and the tests share one definition.
import type {
  ActStatus, ActivityStatus, ConnectionStatus, DocStatus, DocumentStatus, FindingClassLabel, FindingClassification,
  FindingStatus, HashAlgorithm, HashSource, ImplementationStatus, IntegId, LinkStatus, OpenClosed, OwnershipType, RepoStatus,
  ReqStatus, TaskProgressStatus, TupleStatus,
} from '../enums.js';

const REQ_STATUS: Readonly<Record<ImplementationStatus, ReqStatus>> = {
  not_started: 'ns',
  planned: 'planned',
  partially_implemented: 'partial',
  complete: 'complete',
  implemented: 'implemented',
  not_applicable: 'na',
};

/**
 * UI requirement status (C.11): `blocked` when the entry holds the gate and is neither implemented nor not
 * applicable (A.4 5.2); an entry without a status yet reads as `ns`.
 */
export function uiReqStatus(status: ImplementationStatus | null, holdsGate: boolean): ReqStatus {
  const s = status ?? 'not_started';
  if (holdsGate && s !== 'implemented' && s !== 'not_applicable') return 'blocked';
  return REQ_STATUS[s];
}

/** UI document status (C.11): `expired` also when approved and past `next_review_at` (BR-10). */
export function uiDocStatus(status: DocumentStatus, nextReviewAt: string | null, today: string): DocStatus {
  if (status === 'approved' && nextReviewAt !== null && nextReviewAt < today) return 'expired';
  if (status === 'in_review') return 'review';
  return status;
}

const ACT_STATUS: Readonly<Record<ActivityStatus, ActStatus>> = {
  not_started: 'ns',
  in_progress: 'progress',
  complete: 'complete',
  verified: 'verified',
  blocked: 'blocked',
};

/** UI activity status (C.11, D-13): `locked` when not started and the previous phase is not fully verified. */
export function uiActStatus(status: ActivityStatus, previousPhaseVerified: boolean): ActStatus {
  if (status === 'not_started' && !previousPhaseVerified) return 'locked';
  return ACT_STATUS[status];
}

/** Three-state code of preparation tasks and cycle items (C.11, UI 1.10). */
export function uiTupleStatus(status: TaskProgressStatus): TupleStatus {
  if (status === 'done') return 'done';
  if (status === 'in_progress') return 'progress';
  return 'open';
}

/** Finding classification label of `PAST` (C.11); null for classifications the timeline does not list. */
export function uiFindingClass(classification: FindingClassification): FindingClassLabel | null {
  if (classification === 'major') return 'Major';
  if (classification === 'minor') return 'Minor';
  if (classification === 'ofi') return 'OFI';
  return null;
}

/** Finding state of `PAST` (C.11). */
export function uiFindingState(status: FindingStatus): OpenClosed {
  return status === 'closed' ? 'closed' : 'open';
}

/** Repository card status (C.11): `bad` for degraded, failed or revoked; `warn` for personal; else `ok`. */
export function uiRepoStatus(connection: ConnectionStatus, ownership: OwnershipType): RepoStatus {
  if (connection !== 'ok') return 'bad';
  return ownership === 'personal' ? 'warn' : 'ok';
}

/** Storage object state the integrity mapping reads. */
export interface IntegritySource {
  linkStatus: LinkStatus;
  hashAlgorithm: HashAlgorithm;
}

/** UI integrity code (C.12); evidence without a storage object (`external_ref`, A-18) is `ok`. */
export function uiIntegId(object: IntegritySource | null): IntegId {
  if (!object) return 'ok';
  switch (object.linkStatus) {
    case 'intact': return object.hashAlgorithm === 'none' ? 'nohash' : 'ok';
    case 'verification_pending': return 'pending';
    case 'version_changed':
    case 'hash_mismatch': return 'changed';
    case 'moved': return 'moved';
    case 'missing':
    case 'pinned_version_lost': return 'missing';
    case 'access_denied': return 'revoked';
  }
}

/** UI `hashAlg` text of a storage object (C.12). */
export function uiHashAlg(algorithm: HashAlgorithm, source: HashSource): string {
  switch (algorithm) {
    case 'quickxor': return 'quickXorHash';
    case 'sha256': return source === 'provider' ? 'SHA-256 (provider)' : 'SHA-256';
    case 'md5': return 'MD5';
    case 'sha1': return 'SHA-1';
    case 'none': return 'none';
  }
}
