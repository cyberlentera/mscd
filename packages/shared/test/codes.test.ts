// Database values to UI codes (build plan C.11, C.12).
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_STATUSES, ACT_STATUSES, CONNECTION_STATUSES, DOCUMENT_STATUSES, DOC_STATUSES, FINDING_STATUSES, HASH_ALGORITHMS, HASH_SOURCES,
  IMPLEMENTATION_STATUSES, INTEG_IDS, LINK_STATUSES, OWNERSHIP_TYPES, REQ_STATUSES, REPO_STATUSES, TASK_PROGRESS_STATUSES, TUPLE_STATUSES,
  UNVERIFIABLE_INTEG_IDS, uiActStatus, uiDocStatus, uiFindingClass, uiFindingState, uiHashAlg, uiIntegId, uiRepoStatus, uiReqStatus,
  uiTupleStatus,
} from '../src/index.js';

describe('C.11 status codes', () => {
  it('maps requirement status and the gate', () => {
    expect(IMPLEMENTATION_STATUSES.map((s) => uiReqStatus(s, false))).toEqual(['ns', 'planned', 'partial', 'complete', 'implemented', 'na']);
    expect(IMPLEMENTATION_STATUSES.map((s) => uiReqStatus(s, true))).toEqual(['blocked', 'blocked', 'blocked', 'blocked', 'implemented', 'na']);
    expect(uiReqStatus(null, false)).toBe('ns');
    for (const s of IMPLEMENTATION_STATUSES) for (const gate of [true, false]) expect(REQ_STATUSES).toContain(uiReqStatus(s, gate));
  });

  it('maps document status with BR-10 expiry', () => {
    expect(DOCUMENT_STATUSES.map((s) => uiDocStatus(s, null, '2026-07-01'))).toEqual(['draft', 'review', 'approved', 'expired']);
    expect(uiDocStatus('approved', '2026-06-30', '2026-07-01')).toBe('expired');
    expect(uiDocStatus('approved', '2026-07-01', '2026-07-01')).toBe('approved');
    expect(uiDocStatus('in_review', '2026-01-01', '2026-07-01')).toBe('review');
    for (const s of DOCUMENT_STATUSES) expect(DOC_STATUSES).toContain(uiDocStatus(s, '2020-01-01', '2026-07-01'));
  });

  it('maps activity status and the D-13 lock', () => {
    expect(ACTIVITY_STATUSES.map((s) => uiActStatus(s, true))).toEqual(['ns', 'progress', 'complete', 'verified', 'blocked']);
    expect(uiActStatus('not_started', false)).toBe('locked');
    expect(uiActStatus('in_progress', false)).toBe('progress');
    for (const s of ACTIVITY_STATUSES) for (const v of [true, false]) expect(ACT_STATUSES).toContain(uiActStatus(s, v));
  });

  it('maps prep task and cycle item status to three states', () => {
    expect(TASK_PROGRESS_STATUSES.map(uiTupleStatus).sort()).toEqual(
      TASK_PROGRESS_STATUSES.map((s) => (s === 'done' ? 'done' : s === 'in_progress' ? 'progress' : 'open')).sort(),
    );
    for (const s of TASK_PROGRESS_STATUSES) expect(TUPLE_STATUSES).toContain(uiTupleStatus(s));
  });

  it('maps findings', () => {
    expect(uiFindingClass('major')).toBe('Major');
    expect(uiFindingClass('minor')).toBe('Minor');
    expect(uiFindingClass('ofi')).toBe('OFI');
    expect(uiFindingClass('not_a_finding')).toBeNull();
    for (const s of FINDING_STATUSES) expect(uiFindingState(s)).toBe(s === 'closed' ? 'closed' : 'open');
  });

  it('maps repository status', () => {
    expect(uiRepoStatus('ok', 'organizational')).toBe('ok');
    expect(uiRepoStatus('ok', 'personal')).toBe('warn');
    for (const c of CONNECTION_STATUSES.filter((x) => x !== 'ok')) for (const o of OWNERSHIP_TYPES) expect(uiRepoStatus(c, o)).toBe('bad');
    for (const c of CONNECTION_STATUSES) for (const o of OWNERSHIP_TYPES) expect(REPO_STATUSES).toContain(uiRepoStatus(c, o));
  });
});

describe('C.12 integrity codes', () => {
  it('maps every link status', () => {
    const expected: Record<(typeof LINK_STATUSES)[number], string> = {
      intact: 'ok', verification_pending: 'pending', version_changed: 'changed', hash_mismatch: 'changed', moved: 'moved',
      missing: 'missing', pinned_version_lost: 'missing', access_denied: 'revoked',
    };
    for (const s of LINK_STATUSES) expect(uiIntegId({ linkStatus: s, hashAlgorithm: 'sha256' }), s).toBe(expected[s]);
    expect(uiIntegId({ linkStatus: 'intact', hashAlgorithm: 'none' })).toBe('nohash');
    expect(uiIntegId(null)).toBe('ok');
    for (const s of LINK_STATUSES) for (const a of HASH_ALGORITHMS) expect(INTEG_IDS).toContain(uiIntegId({ linkStatus: s, hashAlgorithm: a }));
  });

  it('lists the codes that are unverifiable in UI lists', () => {
    expect([...UNVERIFIABLE_INTEG_IDS].sort()).toEqual(['changed', 'missing', 'moved', 'revoked']);
  });

  it('writes the hash algorithm text', () => {
    expect(uiHashAlg('quickxor', 'provider')).toBe('quickXorHash');
    expect(uiHashAlg('sha256', 'computed')).toBe('SHA-256');
    expect(uiHashAlg('sha256', 'provider')).toBe('SHA-256 (provider)');
    expect(uiHashAlg('md5', 'provider')).toBe('MD5');
    expect(uiHashAlg('sha1', 'provider')).toBe('SHA-1');
    expect(uiHashAlg('none', 'none')).toBe('none');
    for (const a of HASH_ALGORITHMS) for (const s of HASH_SOURCES) expect(uiHashAlg(a, s).length).toBeGreaterThan(0);
  });
});
