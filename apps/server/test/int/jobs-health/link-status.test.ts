// The E.4 precedence (A-06) as a pure function: every outcome of a gateway `stat`, the validity windows of C.12 that
// decide whether an unreachable provider turns a status into `verification_pending` (72 hours for access_denied and
// for an invalid credential, 7 days otherwise), folder paths written with spaces, sticky moves and re-hash findings;
// and the per-repository token bucket of the check.
import type { ObjectMetadata, StatResult } from '@mscd/shared';
import { describe, expect, it } from 'vitest';
import { decideLinkStatus, normaliseFolderPath, type StoredLinkState } from '../../../src/modules/link-health/link-status';
import { RequestPacer } from '../../../src/modules/link-health/request-pacer';

const NOW = new Date('2026-09-29T05:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

const STORED: StoredLinkState = {
  linkStatus: 'intact',
  linkStatusReason: null,
  linkStatusSince: hours(500),
  hashAlgorithm: 'quickxor',
  hashSource: 'provider',
  externalVersionId: '3.0',
  hashValue: 'AAAA',
  folderPath: 'Compliance / ISMS / Evidence / 2026 / Q3',
};

const META: ObjectMetadata = {
  externalItemId: 'demo-sp-EV-0100',
  externalVersionId: '3.0',
  versionLabel: 'v3.0',
  name: 'EV-0100.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  hashAlgorithm: 'quickxor',
  hashValue: 'AAAA',
  hashSource: 'provider',
  providerCreatedAt: null,
  providerModifiedAt: null,
  modifiedBy: null,
  folderPath: 'Compliance/ISMS/Evidence/2026/Q3',
  folderId: 'f',
  webUrl: null,
};

const found = (meta: Partial<ObjectMetadata> = {}, extra: Partial<StatResult> = {}): StatResult => ({
  outcome: 'found',
  current: { ...META, ...meta },
  pinnedVersionAvailable: true,
  folderPath: meta.folderPath ?? META.folderPath!,
  ...extra,
});
const unreachable = (credential = false): StatResult => ({ outcome: 'unreachable', pinnedVersionAvailable: false, ...(credential ? { detail: 'credential_invalid' as const } : {}) });

describe('E.4 precedence', () => {
  it('maps every outcome to its status', () => {
    expect(decideLinkStatus(STORED, found(), NOW, 'm365')).toMatchObject({ status: 'intact', found: true, folderPath: null, checked: true });
    expect(decideLinkStatus(STORED, { outcome: 'not_found', pinnedVersionAvailable: false }, NOW)).toMatchObject({ status: 'missing', found: false });
    expect(decideLinkStatus(STORED, { outcome: 'forbidden', pinnedVersionAvailable: false }, NOW)).toMatchObject({ status: 'access_denied' });
    expect(decideLinkStatus(STORED, unreachable(), NOW)).toMatchObject({ status: 'verification_pending', reason: 'unreachable' });
    expect(decideLinkStatus(STORED, unreachable(true), NOW)).toMatchObject({ status: 'verification_pending', reason: 'credential_invalid' });
    expect(decideLinkStatus(STORED, found({ hashValue: 'BBBB' }), NOW)).toMatchObject({ status: 'hash_mismatch' });
    expect(decideLinkStatus(STORED, found({ externalVersionId: '4.0', hashValue: 'CCCC' }), NOW)).toMatchObject({ status: 'version_changed' });
    expect(decideLinkStatus(STORED, found({ externalVersionId: '4.0' }, { pinnedVersionAvailable: false }), NOW)).toMatchObject({ status: 'pinned_version_lost' });
    expect(decideLinkStatus(STORED, found({ folderPath: 'Compliance/ISMS/Moved' }), NOW)).toMatchObject({ status: 'moved', folderPath: 'Compliance/ISMS/Moved' });
  });

  it('leaves everything as it is when the provider throttles', () => {
    const decision = decideLinkStatus({ ...STORED, linkStatus: 'missing' }, { outcome: 'rate_limited', pinnedVersionAvailable: false, retryAfterSeconds: 30 }, NOW);
    expect(decision).toMatchObject({ checked: false, status: 'missing', found: false, folderPath: null });
  });

  it('applies the precedence in order: hash before version before folder', () => {
    // A provider hash that differs on the pinned version wins over a move.
    expect(decideLinkStatus(STORED, found({ hashValue: 'BBBB', folderPath: 'Elsewhere' }), NOW).status).toBe('hash_mismatch');
    // A new version wins over a move.
    expect(decideLinkStatus(STORED, found({ externalVersionId: '4.0', folderPath: 'Elsewhere' }), NOW).status).toBe('version_changed');
    // A computed hash (vault) is never compared by the link check.
    expect(decideLinkStatus({ ...STORED, hashSource: 'computed', hashAlgorithm: 'sha256', externalVersionId: null }, found({ externalVersionId: null, hashValue: 'x' }), NOW).status).toBe('intact');
  });

  it('treats folder paths written with spaces around the slashes as the same folder; m365 ignores case', () => {
    expect(normaliseFolderPath('Compliance / ISMS / Evidence ')).toBe('Compliance/ISMS/Evidence');
    expect(decideLinkStatus(STORED, found({ folderPath: 'compliance/isms/evidence/2026/q3' }), NOW, 'm365')).toMatchObject({ status: 'intact', folderPath: null });
    expect(decideLinkStatus(STORED, found({ folderPath: 'compliance/isms/evidence/2026/q3' }), NOW, 'google_drive').status).toBe('moved');
  });

  it('keeps a move visible while the item stays where it went, and a re-hash finding until the file is replaced', () => {
    const moved = { ...STORED, linkStatus: 'moved' as const, folderPath: 'Compliance/ISMS/Moved' };
    expect(decideLinkStatus(moved, found({ folderPath: 'Compliance/ISMS/Moved' }), NOW)).toMatchObject({ status: 'moved', folderPath: null });
    const rehashed = { ...STORED, linkStatus: 'hash_mismatch' as const, hashSource: 'computed' as const, hashAlgorithm: 'sha256' as const, externalVersionId: null };
    expect(decideLinkStatus(rehashed, found({ externalVersionId: null }), NOW).status).toBe('hash_mismatch');
    // A missing file that is back where it was is intact again.
    expect(decideLinkStatus({ ...STORED, linkStatus: 'missing' }, found(), NOW).status).toBe('intact');
  });

  describe('validity windows of an unreachable provider (C.12, TS 5.7)', () => {
    it('access_denied: valid for 72 hours, so it becomes verification_pending at 71 hours and stays at 73', () => {
      const at = (h: number): StoredLinkState => ({ ...STORED, linkStatus: 'access_denied', linkStatusSince: hours(h) });
      expect(decideLinkStatus(at(71), unreachable(), NOW)).toMatchObject({ status: 'verification_pending', reason: 'unreachable' });
      expect(decideLinkStatus(at(73), unreachable(), NOW)).toMatchObject({ status: 'access_denied', reason: null });
    });

    it('credential_invalid: valid for 72 hours, after that an unreachable provider changes nothing', () => {
      const at = (h: number): StoredLinkState => ({ ...STORED, linkStatus: 'verification_pending', linkStatusReason: 'credential_invalid', linkStatusSince: hours(h) });
      expect(decideLinkStatus(at(71), unreachable(), NOW)).toMatchObject({ status: 'verification_pending', reason: 'unreachable' });
      expect(decideLinkStatus(at(73), unreachable(), NOW)).toMatchObject({ status: 'verification_pending', reason: 'credential_invalid' });
      expect(decideLinkStatus(at(71), unreachable(true), NOW)).toMatchObject({ status: 'verification_pending', reason: 'credential_invalid' });
    });

    it('unreachable: valid for 7 days, after that a failed credential no longer shortens the window', () => {
      const at = (h: number): StoredLinkState => ({ ...STORED, linkStatus: 'verification_pending', linkStatusReason: 'unreachable', linkStatusSince: hours(h) });
      expect(decideLinkStatus(at(6 * 24), unreachable(true), NOW)).toMatchObject({ reason: 'credential_invalid' });
      expect(decideLinkStatus(at(8 * 24), unreachable(true), NOW)).toMatchObject({ reason: 'unreachable' });
    });

    it('never revives a status that is not valid (missing, hash mismatch, lost pinned version)', () => {
      for (const linkStatus of ['missing', 'hash_mismatch', 'pinned_version_lost'] as const) {
        expect(decideLinkStatus({ ...STORED, linkStatus }, unreachable(true), NOW)).toMatchObject({ status: linkStatus });
      }
    });
  });
});

describe('per-repository token bucket (E.4)', () => {
  it('lets m365 4, google_drive 5 and the vault 50 requests per second through', async () => {
    const pacer = new RequestPacer();
    let now = 0;
    const waits: number[] = [];
    pacer.now = () => now;
    pacer.sleep = async (ms) => {
      waits.push(ms);
      now += ms;
    };
    for (let i = 0; i < 8; i += 1) await pacer.take('sp', 'm365');
    // 4 at once, then one every 250 ms.
    expect(now).toBe(1000);
    expect(waits.every((w) => w === 250)).toBe(true);
    now = 0;
    waits.length = 0;
    for (let i = 0; i < 5; i += 1) await pacer.take('gd', 'google_drive');
    expect(waits).toEqual([]);
    await pacer.take('gd', 'google_drive');
    expect(waits).toEqual([200]);
    waits.length = 0;
    for (let i = 0; i < 50; i += 1) await pacer.take('vault', 'managed_vault');
    expect(waits).toEqual([]);
    // Buckets are per repository: another m365 repository has its own tokens.
    for (let i = 0; i < 4; i += 1) await pacer.take('od', 'm365');
    expect(waits).toEqual([]);
  });
});
