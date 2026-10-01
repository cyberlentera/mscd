// Record refs of the system snapshot (build plan G.5 `refs`, A-21, D.1 Concurrency): every record the bundle shows
// by its RecordKey `<ms>:<kind>:<business id>`, with the UUID that commands take and a weak ETag for If-Match.
import type { RecordModule, RecordRef } from '@mscd/shared';
import { etagOf } from '../../../common/etag';

/** RecordKey kinds of `GET /ui/ms/{ms}` (G.5). */
export type RefKind = 'req' | 'soa' | 'doc' | 'ev' | 'act' | 'x' | 'prep' | 'cycle' | 'drift';

/** Module of a record ref by RecordKey kind (ARCHITECTURE 13): where the record's commands live. */
export const REF_MODULE: Readonly<Record<RefKind, RecordModule>> = {
  req: 'implementation',
  soa: 'implementation',
  act: 'implementation',
  doc: 'implementation',
  ev: 'surveillance',
  x: 'audit',
  prep: 'audit',
  cycle: 'surveillance',
  drift: 'surveillance',
};

export function recordKey(ms: string, kind: RefKind, businessId: string): string {
  return `${ms}:${kind}:${businessId}`;
}

export function recordRef(kind: RefKind, entityType: string, id: string, code: string, updatedAt: Date): RecordRef {
  return { module: REF_MODULE[kind], entityType, id, code, etag: etagOf(updatedAt) };
}

/** Collects refs; a key that is already taken keeps its first record (keys are unique by business id). */
export class RefCollector {
  readonly refs: Record<string, RecordRef> = {};

  add(ms: string, kind: RefKind, businessId: string, ref: RecordRef): string {
    const key = recordKey(ms, kind, businessId);
    if (!this.refs[key]) this.refs[key] = ref;
    return key;
  }
}
