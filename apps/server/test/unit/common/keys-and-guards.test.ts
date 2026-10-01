import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dirtySettings } from '../../../src/db/pool-guard';
import { anchorKeyId, signAnchor, signedAnchorOf, verifyAnchorRow, verifyAnchorSignature, type AnchorPayload } from '../../../src/modules/audit/anchors';
import { FileKeyProvider, kekIdOf, openWithKek, readKekFile, sealWithKek } from '../../../src/modules/keys/file-key-provider';
import { SecretBox, secretAad } from '../../../src/modules/keys/secret-box';

const FIXTURE_KEK = path.resolve(__dirname, '../../fixtures/secrets/platform.key');

describe('KeyProvider file driver and SecretBox (F.11)', () => {
  it('reads the development platform key and seals in the v1 format', async () => {
    const provider = FileKeyProvider.fromFiles(FIXTURE_KEK);
    expect(provider.kekId).toBe(kekIdOf(readKekFile(FIXTURE_KEK)));
    const sealed = await provider.wrap(Buffer.from('totp-secret'), 'mfa:user-1');
    expect(sealed).toMatch(/^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed.split('.')[1]).toBe(provider.kekId);
    expect((await provider.unwrap(sealed, 'mfa:user-1')).toString()).toBe('totp-secret');
  });

  it('refuses another purpose, a tampered value and an unknown key', async () => {
    const provider = new FileKeyProvider(randomBytes(32));
    const sealed = await provider.wrap(Buffer.from('client-secret'), 'idp:p-1');
    await expect(provider.unwrap(sealed, 'idp:p-2')).rejects.toThrow(/cannot be opened/);
    const parts = sealed.split('.');
    const body = Buffer.from(parts[3]!, 'base64url');
    body[0] = body[0]! ^ 1;
    await expect(provider.unwrap([parts[0], parts[1], parts[2], body.toString('base64url')].join('.'), 'idp:p-1')).rejects.toThrow(/cannot be opened/);
    await expect(new FileKeyProvider(randomBytes(32)).unwrap(sealed, 'idp:p-1')).rejects.toThrow(/does not hold/);
    await expect(provider.unwrap('v2.x.y.z', 'idp:p-1')).rejects.toThrow(/Not a sealed value/);
  });

  it('opens values of a previous key during a rotation and flags them for rewrap', async () => {
    const old = randomBytes(32);
    const current = randomBytes(32);
    const sealedOld = sealWithKek(old, Buffer.from('v'), 'pkce:t-1');
    const provider = new FileKeyProvider(current, [old]);
    expect((await provider.unwrap(sealedOld, 'pkce:t-1')).toString()).toBe('v');
    expect(provider.needsRewrap(sealedOld)).toBe(true);
    expect(provider.needsRewrap(await provider.wrap(Buffer.from('v'), 'pkce:t-1'))).toBe(false);
    expect(provider.knownKekIds).toEqual([kekIdOf(current), kekIdOf(old)]);
    expect(openWithKek(old, sealedOld, 'pkce:t-1').toString()).toBe('v');
  });

  it('rejects malformed key files', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mscd-kek-'));
    writeFileSync(path.join(dir, 'short.key'), Buffer.alloc(16).toString('base64'));
    writeFileSync(path.join(dir, 'text.key'), 'not base64!');
    expect(() => readKekFile(path.join(dir, 'short.key'))).toThrow(/32 bytes/);
    expect(() => readKekFile(path.join(dir, 'text.key'))).toThrow(/base64/);
    expect(() => readKekFile(path.join(dir, 'missing.key'))).toThrow(/Cannot read/);
  });

  it('binds SecretBox values to their purpose and owner, and checks MACs in constant time', async () => {
    const box = new SecretBox(new FileKeyProvider(randomBytes(32)));
    expect(secretAad({ purpose: 'mfa', userId: 'u-1' })).toBe('mfa:u-1');
    const sealed = await box.seal('JBSWY3DPEHPK3PXP', { purpose: 'mfa', userId: 'u-1' });
    expect(await box.openText(sealed, { purpose: 'mfa', userId: 'u-1' })).toBe('JBSWY3DPEHPK3PXP');
    await expect(box.open(sealed, { purpose: 'mfa', userId: 'u-2' })).rejects.toThrow();
    const mac = box.mac('calendar', 'user-1:isms');
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(box.verifyMac('calendar', 'user-1:isms', mac)).toBe(true);
    expect(box.verifyMac('redirect', 'user-1:isms', mac)).toBe(false);
    expect(box.verifyMac('calendar', 'user-1:isms', 'zz')).toBe(false);
  });
});

describe('pool guard settings check (F.10)', () => {
  it('accepts clean settings and names each leaked one', () => {
    const clean = { org_id: '', user_id: '', platform_scope: '', search_path: '""', default_search_path: '""' };
    expect(dirtySettings(clean)).toBeNull();
    expect(dirtySettings({ ...clean, org_id: 'x' })).toBe('app.org_id is set');
    expect(dirtySettings({ ...clean, platform_scope: 'on', user_id: 'u' })).toBe('app.user_id is set, app.platform_scope is set');
    expect(dirtySettings({ ...clean, search_path: '"org_ndt", ext' })).toMatch(/search_path is/);
  });
});

describe('audit anchors (D-33, F.11)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = anchorKeyId(publicKey);
  const trusted = [{ keyId, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
  const payload: AnchorPayload = {
    chain: 'org_ndt.audit_trail',
    seq: 42,
    rowHash: 'ab'.repeat(32),
    anchoredAt: '2026-09-29T04:00:00.000Z',
    installationId: '00000000-0000-4000-8000-0000000000f1',
  };

  it('signs the canonical payload and verifies it with the trusted key only', () => {
    const signed = signAnchor(payload, privateKey, publicKey);
    expect(signed.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(signed.signature).toMatch(/^ed25519:[A-Za-z0-9+/]{86}==$/);
    expect(verifyAnchorSignature(signed, trusted)).toBe(true);
    expect(verifyAnchorSignature({ ...signed, seq: 43 }, trusted)).toBe(false);
    expect(verifyAnchorSignature(signed, [])).toBe(false);
    const other = generateKeyPairSync('ed25519');
    expect(verifyAnchorSignature(signed, [{ keyId, publicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() }])).toBe(false);
  });

  it('checks a stored row: payload consistent with its columns and signed', () => {
    const signed = signAnchor(payload, privateKey, publicKey);
    const row = { chain: payload.chain, seq: '42', row_hash: Buffer.from(payload.rowHash, 'hex'), payload, signature: signed.signature, key_id: keyId };
    expect(signedAnchorOf(row)).toEqual(signed);
    expect(verifyAnchorRow(row, trusted)).toBe(true);
    expect(verifyAnchorRow({ ...row, seq: '41' }, trusted)).toBe(false);
    expect(verifyAnchorRow({ ...row, row_hash: Buffer.alloc(32) }, trusted)).toBe(false);
    expect(verifyAnchorRow({ ...row, payload: { ...payload, installationId: 'x' } }, trusted)).toBe(false);
  });
});
