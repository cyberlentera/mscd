// Requirement, document and evidence derivations (G.5 `bundle.reqs`, `bundle.docs`, `bundle.evs`, C.11, C.12).
import { describe, expect, it } from 'vitest';
import { deriveDocument, isSharedDocument, sortDocuments } from '../../../src/modules/read-model/derive/documents';
import { deriveEvidence } from '../../../src/modules/read-model/derive/evidence';
import type { DocumentRow, EntryRow, EvidenceRow, StorageObjectRow } from '../../../src/modules/read-model/derive/inputs';
import { deriveRequirement, justificationOf, requirementId, requirementKey, requirementTheme } from '../../../src/modules/read-model/derive/requirements';
import { loadSampleSnapshot } from '../../../src/seed/snapshot';

const sample = loadSampleSnapshot();
const T0 = new Date('2026-09-01T00:00:00Z');

function entry(over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 'e1', updatedAt: T0, targetType: 'catalogue_item', code: 'A.5.23', title: 'Information security for use of cloud services', themeCode: 'A.5',
    clauseGroup: null, status: 'not_started', holdsGate: false, gateReason: null, isApplicable: true, inclusionJustification: 'Risk R-022',
    exclusionJustification: null, owner: 'andi', statusNote: null, frequency: 'annual', documentCodes: ['POL-01', 'PRC-08'], riskCodes: ['R-022'],
    completedBy: null, actionDueAt: null, justificationHolder: null, justificationDueAt: null, position: 0, ...over,
  };
}

describe('requirements (G.5 bundle.reqs)', () => {
  it('builds id, key and theme for catalogue items and requirements', () => {
    expect(requirementId('catalogue_item', 'A.8.12')).toBe('A.8.12');
    expect(requirementId('requirement', '8.4')).toBe('Cl. 8.4');
    expect(requirementKey('A.8.12')).toBe('8.12');
    expect(requirementKey('8.4')).toBe('8.4');
    expect(requirementTheme(entry(), { 5: 'Organizational' })).toBe('A.5 Organizational');
    expect(requirementTheme(entry({ targetType: 'requirement', code: '9.1.2', clauseGroup: '9', themeCode: null }), {})).toBe('Clause 9');
  });

  it('maps status, gate, justification, owner and completion (C.11)', () => {
    expect(deriveRequirement(entry({ holdsGate: true, statusNote: 'Applicable: no risk-based justification linked' }), { 5: 'Organizational' })).toEqual({
      id: 'A.5.23', key: '5.23', title: 'Information security for use of cloud services', theme: 'A.5 Organizational', st: 'blocked', owner: 'andi',
      doc: 'POL-01', freq: 'annual', note: 'Applicable: no risk-based justification linked', gate: true, just: 'Risk R-022', risks: ['R-022'],
    });
    expect(deriveRequirement(entry({ status: 'complete', completedBy: 'bagus', owner: null, documentCodes: [] }), {})).toMatchObject({ st: 'complete', by: 'bagus', owner: 'none', doc: '' });
    expect(deriveRequirement(entry({ status: 'implemented', holdsGate: true }), {}).st).toBe('implemented');
    expect(justificationOf({ status: 'not_applicable', isApplicable: false, inclusionJustification: 'x', exclusionJustification: 'Not in scope' })).toBe('Not in scope');
    expect(justificationOf({ status: 'planned', isApplicable: true, inclusionJustification: null, exclusionJustification: null })).toBe('');
  });
});

function doc(over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'd1', updatedAt: T0, code: 'PRC-07', title: 'Access Control Procedure', docType: 'procedure', status: 'approved', classification: 'internal',
    owner: 'bagus', approver: 'hendra', approvedAt: '2025-09-24', nextReviewAt: '2026-09-24', orgWide: false, linkedMsIds: ['ms-isms'], versionLabel: '3.2',
    object: null, pendingHolder: null, pendingDueAt: null, position: 3, ...over,
  };
}

describe('documents (G.5 bundle.docs)', () => {
  const ctx = { ms: 'isms', msId: 'ms-isms', today: '2026-09-29', docTypeLabels: { procedure: 'Procedure' }, systemCodes: new Map([['ms-isms', 'ISMS'], ['ms-qms', 'QMS']]) };

  it('reads an approved document past its review date as expired (BR-10) and maps in_review to review', () => {
    expect(deriveDocument(doc(), ctx)).toEqual({
      id: 'PRC-07', title: 'Access Control Procedure', tier: 'Procedure', ver: '3.2', st: 'expired', appr: '2025-09-24', rev: '2026-09-24', owner: 'bagus',
      shared: false, ms: 'isms', usedBy: [], approver: 'hendra',
    });
    expect(deriveDocument(doc({ nextReviewAt: '2026-09-29' }), ctx).st).toBe('approved');
    expect(deriveDocument(doc({ status: 'in_review', versionLabel: null, approvedAt: null }), ctx)).toMatchObject({ st: 'review', ver: '-', appr: '' });
  });

  it('marks shared documents and lists the other systems that use them, organisation-wide documents last', () => {
    const shared = doc({ code: 'IMS-01', orgWide: true, linkedMsIds: ['ms-isms', 'ms-qms'], position: 0 });
    expect(isSharedDocument(shared)).toBe(true);
    expect(isSharedDocument(doc({ linkedMsIds: ['ms-isms', 'ms-qms'] }))).toBe(true);
    expect(deriveDocument(shared, ctx).usedBy).toEqual(['QMS']);
    expect(sortDocuments([shared, doc({ position: 5, code: 'B' }), doc({ position: 1, code: 'A' })]).map((d) => d.code)).toEqual(['A', 'B', 'IMS-01']);
  });

  it('takes path and hash text from the current version file', () => {
    const object: StorageObjectRow = {
      id: 'o1', repositorySlug: 'sp', versionLabel: '3.2', folderPath: 'Compliance / ISMS / Documents', hashAlgorithm: 'quickxor', hashValue: 'abc', hashSource: 'provider',
      linkStatus: 'intact', linkStatusSince: T0, linkStatusReason: null, lastVerifiedAt: T0, lastGoodCheckAt: T0,
    };
    expect(deriveDocument(doc({ object }), ctx)).toMatchObject({ path: 'Compliance / ISMS / Documents', hashAlg: 'quickXorHash' });
  });
});

describe('evidence (G.5 bundle.evs, E.3, C.12)', () => {
  const frequencies = new Map(Object.entries(sample.raw.FREQ).map(([code, f], i) => [code, { code, labelEn: f[0], labelId: f[1], periodDays: f[2], sortOrder: i }]));
  const ctx = { msId: 'ms-isms', today: '2026-09-29', timeZone: 'Asia/Jakarta', frequencies, thresholds: [], entries: new Map([['e1', { id: 'A.5.9', key: '5.9' }]]) };
  const object: StorageObjectRow = {
    id: 'o1', repositorySlug: 'sp', versionLabel: 'v3.0', folderPath: 'Compliance / ISMS / Evidence / 2026 / Q3', hashAlgorithm: 'quickxor', hashValue: 'h==',
    hashSource: 'provider', linkStatus: 'version_changed', linkStatusSince: T0, linkStatusReason: null,
    lastVerifiedAt: new Date('2026-09-28T23:00:00Z'), lastGoodCheckAt: new Date('2026-09-20T23:00:00Z'),
  };
  const row = (over: Partial<EvidenceRow> = {}): EvidenceRow => ({
    id: 'v1', updatedAt: T0, code: 'EV-0124', title: 'Asset register export', owner: 'bagus', producedAt: '2026-06-21', frequency: 'quarterly',
    nextDueOverride: null, classification: 'internal', entryId: 'e1', object, position: 0, ...over,
  });

  it('derives period, dates, freshness, integrity and the file fields', () => {
    expect(deriveEvidence(row(), ctx)).toEqual({
      code: 'EV-0124', ctrl: 'A.5.9', ctrlKey: '5.9', title: 'Asset register export', freq: 'quarterly', p: 91, prod: '2026-06-21', next: '2026-09-20',
      fresh: 'aging', integ: 'changed', loc: 'sp', owner: 'bagus', ver: 'v3.0', hashAlg: 'quickXorHash', path: 'Compliance / ISMS / Evidence / 2026 / Q3',
      hash: 'h==', lastCheck: '29 Sep 2026 06:00', lastGoodCheck: '21 Sep 2026 06:00',
    });
  });

  it('handles per-event evidence, a due date override and evidence without a file', () => {
    expect(deriveEvidence(row({ frequency: 'event', producedAt: '2025-01-01' }), ctx)).toMatchObject({ p: 0, next: null, fresh: 'fresh' });
    expect(deriveEvidence(row({ nextDueOverride: '2026-10-31' }), ctx).next).toBe('2026-10-31');
    expect(deriveEvidence(row({ object: null }), ctx)).toMatchObject({ integ: 'ok', loc: '', ver: '-', hashAlg: 'none', path: '' });
  });
});
