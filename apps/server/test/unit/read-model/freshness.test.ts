// E.3 freshness and C.12 integrity derivations: small fixtures and every evidence record of the sample snapshot.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS, entryEvidenceState, evidenceState, freshnessBand, nextDue, thresholdsFor, type EvidenceState, type ThresholdRow,
} from '../../../src/modules/read-model/derive/freshness';
import {
  br01LinkOk, hashAlgText, integOf, integrityStatus, isMissingFile, isUnverifiable, validForStatus, type StorageObjectState,
} from '../../../src/modules/read-model/derive/integrity';
import { loadSampleSnapshot } from '../../../src/seed/snapshot';

const sample = loadSampleSnapshot();
const NOW = new Date('2026-09-29T05:00:00.000Z');
const HOUR = 3_600_000;

function object(linkStatus: StorageObjectState['linkStatus'], extra: Partial<StorageObjectState> = {}): StorageObjectState {
  return { linkStatus, hashAlgorithm: 'sha256', hashSource: 'computed', linkStatusSince: new Date(NOW.getTime() - HOUR), linkStatusReason: null, ...extra };
}

describe('E.3 freshness band', () => {
  it('uses the A-42 defaults: fresh up to p + 1, aging up to 1.25p + 1, expired up to 2p, then critical', () => {
    const today = '2026-09-29';
    // Monthly (30 days): fresh <= 31, aging <= 38.5, expired <= 60.
    expect(freshnessBand('2026-08-29', 30, today)).toBe('fresh'); // 31 days
    expect(freshnessBand('2026-08-28', 30, today)).toBe('aging'); // 32
    expect(freshnessBand('2026-08-22', 30, today)).toBe('aging'); // 38
    expect(freshnessBand('2026-08-21', 30, today)).toBe('expired'); // 39
    expect(freshnessBand('2026-07-31', 30, today)).toBe('expired'); // 60
    expect(freshnessBand('2026-07-30', 30, today)).toBe('critical'); // 61
    expect(freshnessBand('2020-01-01', 0, today)).toBe('fresh');
    expect(freshnessBand(null, 30, today)).toBe('critical');
    expect(freshnessBand(null, 0, today)).toBe('fresh');
  });

  it('takes the thresholds of the system, then of the organisation, else the defaults', () => {
    const rows: ThresholdRow[] = [
      { managementSystemId: null, frequencyCode: 'monthly', freshGraceDays: 5, agingFactor: 1.5, expiredFactor: 3 },
      { managementSystemId: 'ms-1', frequencyCode: 'monthly', freshGraceDays: 0, agingFactor: 1, expiredFactor: 1 },
    ];
    expect(thresholdsFor(rows, 'ms-1', 'monthly')).toEqual({ grace: 0, aging: 1, expired: 1 });
    expect(thresholdsFor(rows, 'ms-2', 'monthly')).toEqual({ grace: 5, aging: 1.5, expired: 3 });
    expect(thresholdsFor(rows, 'ms-2', 'weekly')).toEqual(DEFAULT_THRESHOLDS);
    expect(freshnessBand('2026-08-25', 30, '2026-09-29', thresholdsFor(rows, 'ms-2', 'monthly'))).toBe('fresh'); // 35 <= 35
    expect(freshnessBand('2026-08-29', 30, '2026-09-29', thresholdsFor(rows, 'ms-1', 'monthly'))).toBe('critical'); // 31 > 30
  });

  it('computes the next due date from the override, else produced + p', () => {
    expect(nextDue('2026-09-01', 30, null)).toBe('2026-10-01');
    expect(nextDue('2026-09-01', 30, '2026-09-15')).toBe('2026-09-15');
    expect(nextDue('2026-09-01', 0, null)).toBeNull();
    expect(nextDue(null, 30, null)).toBeNull();
  });

  it('reproduces fresh and next of every evidence record of the sample', () => {
    let checked = 0;
    for (const snapshot of Object.values(sample.snapshots)) {
      for (const bundle of Object.values(snapshot.bundles)) {
        for (const e of bundle.evs) {
          expect({ code: e.code, fresh: freshnessBand(e.prod, e.p, sample.today) }).toEqual({ code: e.code, fresh: e.fresh });
          const computed = e.p > 0 ? nextDue(e.prod, e.p, null) : null;
          expect(nextDue(e.prod, e.p, e.next !== computed ? e.next : null)).toBe(e.next);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});

describe('C.12 integrity', () => {
  it('maps link states to the UI codes and hash algorithms to their text', () => {
    expect(integOf(null)).toBe('ok');
    expect(integOf(object('intact'))).toBe('ok');
    expect(integOf(object('intact', { hashAlgorithm: 'none', hashSource: 'none' }))).toBe('nohash');
    expect(integOf(object('verification_pending'))).toBe('pending');
    expect(integOf(object('version_changed'))).toBe('changed');
    expect(integOf(object('hash_mismatch'))).toBe('changed');
    expect(integOf(object('moved'))).toBe('moved');
    expect(integOf(object('missing'))).toBe('missing');
    expect(integOf(object('pinned_version_lost'))).toBe('missing');
    expect(integOf(object('access_denied'))).toBe('revoked');
    expect(['ok', 'nohash', 'pending', 'changed', 'moved', 'missing', 'revoked'].filter((c) => isUnverifiable(c as never))).toEqual(['changed', 'moved', 'missing', 'revoked']);
    expect(isMissingFile('missing') && isMissingFile('revoked') && !isMissingFile('changed')).toBe(true);
    expect(hashAlgText(null)).toBe('none');
    expect(hashAlgText({ hashAlgorithm: 'quickxor', hashSource: 'provider' })).toBe('quickXorHash');
    expect(hashAlgText({ hashAlgorithm: 'sha256', hashSource: 'computed' })).toBe('SHA-256');
    expect(hashAlgText({ hashAlgorithm: 'sha256', hashSource: 'provider' })).toBe('SHA-256 (provider)');
  });

  it('applies the validity windows: pending 7 days (72 hours with an invalid credential), access denied 72 hours', () => {
    const since = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
    expect(validForStatus(null, NOW)).toBe(true);
    expect(validForStatus(object('intact'), NOW)).toBe(true);
    expect(validForStatus(object('moved'), NOW)).toBe(true);
    expect(validForStatus(object('version_changed'), NOW)).toBe(true);
    expect(validForStatus(object('hash_mismatch'), NOW)).toBe(false);
    expect(validForStatus(object('missing'), NOW)).toBe(false);
    expect(validForStatus(object('verification_pending', { linkStatusSince: since(6 * 24) }), NOW)).toBe(true);
    expect(validForStatus(object('verification_pending', { linkStatusSince: since(8 * 24) }), NOW)).toBe(false);
    expect(validForStatus(object('verification_pending', { linkStatusSince: since(71), linkStatusReason: 'credential_invalid' }), NOW)).toBe(true);
    expect(validForStatus(object('verification_pending', { linkStatusSince: since(73), linkStatusReason: 'credential_invalid' }), NOW)).toBe(false);
    expect(validForStatus(object('access_denied', { linkStatusSince: since(71) }), NOW)).toBe(true);
    expect(validForStatus(object('access_denied', { linkStatusSince: since(73) }), NOW)).toBe(false);
  });

  it('gives the A-05 integrity status and the BR-01 link rule', () => {
    expect(integrityStatus(null, NOW)).toBe('ok');
    expect(integrityStatus(object('intact'), NOW)).toBe('ok');
    expect(integrityStatus(object('moved'), NOW)).toBe('ok');
    expect(integrityStatus(object('intact', { hashAlgorithm: 'none', hashSource: 'none' }), NOW)).toBe('degraded');
    expect(integrityStatus(object('version_changed'), NOW)).toBe('degraded');
    expect(integrityStatus(object('verification_pending'), NOW)).toBe('degraded');
    expect(integrityStatus(object('verification_pending', { linkStatusSince: new Date(NOW.getTime() - 8 * 24 * HOUR) }), NOW)).toBe('broken');
    expect(integrityStatus(object('access_denied'), NOW)).toBe('degraded');
    expect(integrityStatus(object('hash_mismatch'), NOW)).toBe('broken');
    expect(integrityStatus(object('pinned_version_lost'), NOW)).toBe('broken');
    expect(br01LinkOk(null)).toBe(true);
    expect(br01LinkOk(object('intact'))).toBe(true);
    expect(br01LinkOk(object('moved'))).toBe(true);
    expect(br01LinkOk(object('version_changed'))).toBe(false);
    expect(br01LinkOk(object('verification_pending'))).toBe(false);
  });
});

describe('E.3 entryEvidenceState', () => {
  const today = '2026-09-29';
  const ev = (producedAt: string | null, linkStatus: StorageObjectState['linkStatus'] | null, periodDays = 30): EvidenceState => ({
    producedAt,
    periodDays,
    thresholds: DEFAULT_THRESHOLDS,
    object: linkStatus ? object(linkStatus) : null,
  });

  it('satisfies BR-01 with a fresh, valid, intact item of the current period', () => {
    const state = entryEvidenceState([ev('2026-09-20', 'intact')], today, NOW);
    expect(state).toEqual({ satisfiesBr01: true, keepsImplemented: true, lastEvidenceAt: '2026-09-20', freshnessStatus: 'fresh', integrityStatus: 'ok' });
  });

  it('does not let a newer broken item undo an older valid one (no downgrade, BR-01 still satisfied)', () => {
    const state = entryEvidenceState([ev('2026-09-10', 'intact'), ev('2026-09-25', 'hash_mismatch')], today, NOW);
    expect(state.keepsImplemented).toBe(true);
    expect(state.satisfiesBr01).toBe(true);
    expect(state.lastEvidenceAt).toBe('2026-09-10');
  });

  it('keeps implemented on aging evidence but needs the current period for BR-01', () => {
    const state = entryEvidenceState([ev('2026-08-25', 'intact')], today, NOW); // 35 days: aging, outside 31
    expect(state).toMatchObject({ keepsImplemented: true, satisfiesBr01: false, freshnessStatus: 'aging' });
  });

  it('refuses BR-01 on a valid link that is not intact or moved, and downgrades without candidates', () => {
    expect(entryEvidenceState([ev('2026-09-20', 'version_changed')], today, NOW)).toMatchObject({ keepsImplemented: true, satisfiesBr01: false });
    const none = entryEvidenceState([ev('2026-06-01', 'intact'), ev('2026-09-28', 'missing')], today, NOW);
    expect(none).toMatchObject({ keepsImplemented: false, satisfiesBr01: false, lastEvidenceAt: '2026-09-28', freshnessStatus: 'fresh', integrityStatus: 'broken' });
    expect(entryEvidenceState([], today, NOW)).toEqual({ satisfiesBr01: false, keepsImplemented: false, lastEvidenceAt: null, freshnessStatus: null, integrityStatus: null });
  });

  it('accepts per-event evidence of any date and evidence without a storage object', () => {
    expect(entryEvidenceState([ev('2020-01-01', 'intact', 0)], today, NOW)).toMatchObject({ satisfiesBr01: true, keepsImplemented: true });
    expect(entryEvidenceState([ev('2026-09-20', null)], today, NOW)).toMatchObject({ satisfiesBr01: true, integrityStatus: 'ok' });
    expect(evidenceState(ev('2026-09-20', 'access_denied'), today, NOW)).toMatchObject({ candidate: true, br01LinkOk: false, integrity: 'degraded' });
  });
});
