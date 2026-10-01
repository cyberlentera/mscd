// Documents of a system (build plan G.5 `bundle.docs`, C.11, UI 1.6, UI 2.4).
import { uiDocStatus, type Document } from '@mscd/shared';
import type { DocumentRow } from './inputs';
import { hashAlgText } from './integrity';
import { NONE } from './text';

export interface DocumentContext {
  /** Slug of the system whose bundle is built. */
  ms: string;
  msId: string;
  today: string;
  /** Label of each `doc_type` code (`ref.lookup_value`, domain `doc_type`). */
  docTypeLabels: Readonly<Record<string, string>>;
  /** System code (`management_system.code`) by system id, for `usedBy`. */
  systemCodes: ReadonlyMap<string, string>;
}

/** G.5 `shared`: organisation-wide, or linked to two or more systems. */
export function isSharedDocument(doc: Pick<DocumentRow, 'orgWide' | 'linkedMsIds'>): boolean {
  return doc.orgWide || doc.linkedMsIds.length >= 2;
}

/**
 * Order of `bundle.docs` (G.5): documents that are not organisation-wide first, then organisation-wide ones, each by
 * position, then code.
 */
export function sortDocuments<T extends Pick<DocumentRow, 'orgWide' | 'position' | 'code'>>(docs: readonly T[]): T[] {
  return [...docs].sort((a, b) => Number(a.orgWide) - Number(b.orgWide) || a.position - b.position || a.code.localeCompare(b.code));
}

/** One document of `bundle.docs` (G.5). */
export function deriveDocument(doc: DocumentRow, ctx: DocumentContext): Document {
  const out: Document = {
    id: doc.code,
    title: doc.title,
    tier: ctx.docTypeLabels[doc.docType] ?? doc.docType,
    ver: doc.versionLabel ?? '-',
    st: uiDocStatus(doc.status, doc.nextReviewAt, ctx.today),
    appr: doc.approvedAt ?? '',
    rev: doc.nextReviewAt ?? '',
    owner: doc.owner ?? NONE,
    shared: isSharedDocument(doc),
    ms: ctx.ms,
    usedBy: doc.linkedMsIds.filter((id) => id !== ctx.msId).map((id) => ctx.systemCodes.get(id) ?? id),
  };
  if (doc.approver) out.approver = doc.approver;
  if (doc.object?.folderPath) out.path = doc.object.folderPath;
  if (doc.object) out.hashAlg = hashAlgText(doc.object);
  return out;
}
