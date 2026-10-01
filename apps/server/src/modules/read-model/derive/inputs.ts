// Rows the derivation functions read, in the shape the loaders produce them (`../load`). Person columns are already
// handles (null for Unassigned), dates are `YYYY-MM-DD` local dates and instants are `Date` objects, so every
// derivation is a pure function that unit tests can feed with small fixtures or the sample snapshot.
import type { ActivityStatus, DocumentStatus, ImplementationStatus } from '@mscd/shared';
import type { StorageObjectState } from './integrity';

/** An `applicability_entry` with its target and links (G.5 `bundle.reqs`). */
export interface EntryRow {
  id: string;
  updatedAt: Date;
  targetType: 'catalogue_item' | 'requirement';
  /** `item_code` of the catalogue item or `requirement_code` of the requirement. */
  code: string;
  title: string;
  /** Catalogue theme code (`A.5`) of a catalogue item. */
  themeCode: string | null;
  /** Clause group (`4` to `10`) of a requirement. */
  clauseGroup: string | null;
  status: ImplementationStatus | null;
  holdsGate: boolean;
  gateReason: string | null;
  isApplicable: boolean | null;
  inclusionJustification: string | null;
  exclusionJustification: string | null;
  owner: string | null;
  statusNote: string | null;
  /** `operating_criteria.frequency_code`, else the target's default frequency. */
  frequency: string;
  /** Linked document codes by position. */
  documentCodes: string[];
  /** Linked risk codes by position. */
  riskCodes: string[];
  completedBy: string | null;
  actionDueAt: string | null;
  justificationHolder: string | null;
  justificationDueAt: string | null;
  position: number;
}

/** The storage object behind an evidence record or a document version. */
export interface StorageObjectRow extends StorageObjectState {
  id: string;
  repositorySlug: string;
  versionLabel: string | null;
  folderPath: string | null;
  hashValue: string | null;
  lastVerifiedAt: Date | null;
  lastGoodCheckAt: Date | null;
}

/** A `document` linked to the system (G.5 `bundle.docs`). */
export interface DocumentRow {
  id: string;
  updatedAt: Date;
  code: string;
  title: string;
  docType: string;
  status: DocumentStatus;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  owner: string | null;
  approver: string | null;
  approvedAt: string | null;
  nextReviewAt: string | null;
  orgWide: boolean;
  /** Ids of the systems the document is linked to (`entity_ms_link`), in system order. */
  linkedMsIds: string[];
  /** Current version label, null without a version. */
  versionLabel: string | null;
  object: StorageObjectRow | null;
  /** Holder and due date of the pending review action (assignment of a `doc` chain item). */
  pendingHolder: string | null;
  pendingDueAt: string | null;
  position: number;
}

/** An `evidence` record targeting an applicability entry of the system (G.5 `bundle.evs`). */
export interface EvidenceRow {
  id: string;
  updatedAt: Date;
  code: string;
  title: string;
  owner: string | null;
  producedAt: string | null;
  frequency: string;
  nextDueOverride: string | null;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  /** The first entry of the system the evidence targets. */
  entryId: string;
  object: StorageObjectRow | null;
  position: number;
}

/** A chain record of an entity or justification stage (C.10: the stage's table, or `chain_record`). */
export interface ChainRecordRow {
  id: string;
  updatedAt: Date;
  /** Table of the record (`risk`, `chain_record`, ...). */
  table: string;
  stage: string;
  code: string;
  title: string;
  holder: string | null;
  pendingAction: string | null;
  actionDueAt: string | null;
  gate: boolean;
  up: string[];
  down: string[];
  position: number;
}

/** An `implementation_activity_progress` row with its phase from the template (G.5 `bundle.phases`, D-30). */
export interface ActivityRow {
  id: string;
  updatedAt: Date;
  phaseNo: number;
  activityNo: number;
  phaseName: string;
  isGatePhase: boolean;
  title: string;
  status: ActivityStatus;
  owner: string | null;
  outputDocumentCode: string | null;
  /** Code of the document `output_document_id` points to, when set. */
  linkedDocumentCode: string | null;
  blockerGateItemRef: string | null;
  dueAt: string | null;
  verifiedAt: string | null;
  completedBy: string | null;
}

/** A chain stage of the system's active framework version (`ref.traceability_chain_def`). */
export interface StageDef {
  key: string;
  position: number;
  labelEn: string;
  labelId: string;
  questionEn: string;
  source: 'entity' | 'applicability' | 'justification' | 'document' | 'evidence';
  entityType: string | null;
  riskProfileCode: string | null;
  clauseAtRisk: string | null;
  overviewClause: number;
  gateTypeLabel: [string, string] | null;
}

/** An evidence frequency of the pack (`ref.evidence_frequency_rule`). */
export interface FrequencyDef {
  code: string;
  labelEn: string;
  labelId: string;
  periodDays: number;
  sortOrder: number;
}
