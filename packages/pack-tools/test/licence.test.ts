// Licences (D-15, E.8): canonical JSON signed with Ed25519, key ids, trusted and rejected keys, binding rules, and
// the development licences of G.3.
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, licenceSigningPayload } from '@mscd/shared';
import { describe, expect, it } from 'vitest';
import { DEV_KEY_IDS, LicenceError, generateSigningKeyPair, keyId, signLicence, verifyLicence } from '../src/index.js';
import { DEV_KEYS_DIR, DEV_LICENCES_DIR } from './helpers.js';

const UNSIGNED = {
  license_id: 'LIC-TEST-1', organization: 'Client A', organization_id: '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c',
  valid_from: '2026-10-01', valid_until: '2027-09-30', grace_days: 30, frameworks: ['ISO27001', 'ISO9001'], max_management_systems: 4,
  max_users: 400, storage_adapters: ['managed_vault', 'm365'], features: ['integrated_mode'],
};

function licenceError(fn: () => unknown): LicenceError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LicenceError);
    return error as LicenceError;
  }
  throw new Error('expected a LicenceError');
}

describe('signLicence and verifyLicence', () => {
  const key = generateSigningKeyPair();

  it('signs the canonical JSON without the signature and sets key_id', () => {
    const signed = signLicence(UNSIGNED, key.privateKey);
    expect(signed.key_id).toBe(key.keyId);
    expect(Object.keys(signed).slice(-2)).toEqual(['key_id', 'signature']);
    expect(signed.signature).toMatch(/^ed25519:[A-Za-z0-9+/]{86}==$/);
    const expected = sign(null, Buffer.from(canonicalJson({ ...UNSIGNED, key_id: key.keyId })), key.privateKey).toString('base64');
    expect(signed.signature).toBe(`ed25519:${expected}`);
    const verified = verifyLicence(signed, [key.publicKey]);
    expect(verified.keyId).toBe(key.keyId);
    expect(verified.binding).toEqual({ kind: 'organization', id: UNSIGNED.organization_id });
  });

  it('verifies JSON text and buffers in any member order and formatting', () => {
    const signed = signLicence(UNSIGNED, key.privateKeyPem);
    const reordered = Object.fromEntries(Object.entries(signed).reverse());
    expect(verifyLicence(JSON.stringify(reordered), [key.publicKeyPem]).document.license_id).toBe('LIC-TEST-1');
    expect(verifyLicence(Buffer.from(JSON.stringify(signed, null, 4)), [key.publicKeyPem]).keyId).toBe(key.keyId);
    // A byte order mark (some editors add one) is not part of the document.
    expect(verifyLicence(`\uFEFF${JSON.stringify(signed)}`, [key.publicKey]).keyId).toBe(key.keyId);
    expect(verifyLicence(Buffer.from(`\uFEFF${JSON.stringify(signed)}`), [key.publicKey]).keyId).toBe(key.keyId);
  });

  it('re-signing replaces the signature and key id', () => {
    const other = generateSigningKeyPair();
    const resigned = signLicence(signLicence(UNSIGNED, key.privateKey), other.privateKey);
    expect(resigned.key_id).toBe(other.keyId);
    expect(verifyLicence(resigned, [other.publicKey]).keyId).toBe(other.keyId);
    expect(licenceError(() => verifyLicence(resigned, [key.publicKey])).code).toBe('untrusted_key');
  });

  it('rejects any change after signing, including unknown members', () => {
    const signed = signLicence({ ...UNSIGNED, future_field: { a: 1 } }, key.privateKey);
    expect(verifyLicence(signed, [key.publicKey]).document.future_field).toEqual({ a: 1 });
    for (const tampered of [
      { ...signed, max_users: 4000 },
      { ...signed, features: [...UNSIGNED.features, 'auditor_guest_access'] },
      { ...signed, valid_until: '2099-12-31' },
      { ...signed, future_field: { a: 2 } },
      { ...signed, added: true },
    ]) {
      expect(licenceError(() => verifyLicence(tampered, [key.publicKey])).code).toBe('signature');
    }
  });

  it('rejects a licence whose key id names a key that did not sign it', () => {
    const other = generateSigningKeyPair();
    const signed = signLicence(UNSIGNED, other.privateKey);
    const forged = { ...signed, key_id: key.keyId };
    expect(licenceError(() => verifyLicence(forged, [key.publicKey, other.publicKey])).code).toBe('signature');
  });

  it('uses only licence keys among typed trusted keys', () => {
    const signed = signLicence(UNSIGNED, key.privateKey);
    expect(verifyLicence(signed, [{ kind: 'licence', keyId: key.keyId, publicKeyPem: key.publicKeyPem }]).keyId).toBe(key.keyId);
    expect(licenceError(() => verifyLicence(signed, [{ kind: 'pack', publicKeyPem: key.publicKeyPem }])).code).toBe('untrusted_key');
    expect(licenceError(() => verifyLicence(signed, [])).code).toBe('untrusted_key');
  });

  it('rejects documents that break the licence schema', () => {
    const signed = signLicence(UNSIGNED, key.privateKey);
    for (const bad of ['{', '[]', 'null', { ...signed, signature: 'ed25519:short' }, { ...signed, key_id: 'licence-signing' }, { ...signed, storage_adapters: ['dropbox'] }, { ...signed, installation_id: '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c' }]) {
      expect(licenceError(() => verifyLicence(bad, [key.publicKey])).code).toBe('format');
    }
    expect(licenceError(() => signLicence({ ...UNSIGNED, valid_until: '2026-01-01' }, key.privateKey)).code).toBe('format');
    expect(licenceError(() => signLicence({ ...UNSIGNED, when: new Date() }, key.privateKey)).code).toBe('format');
  });

  it('applies the binding rule: a bound licence, or a trial of at most 90 days', () => {
    const { organization_id: _org, ...unbound } = UNSIGNED;
    expect(licenceError(() => signLicence(unbound, key.privateKey)).code).toBe('binding');
    const trial = signLicence({ ...unbound, trial: true, valid_from: '2026-10-01', valid_until: '2026-12-30' }, key.privateKey);
    expect(verifyLicence(trial, [key.publicKey]).binding).toEqual({ kind: 'trial' });
    expect(licenceError(() => signLicence({ ...unbound, trial: true, valid_from: '2026-10-01', valid_until: '2026-12-31' }, key.privateKey)).code).toBe('binding');
    const installation = signLicence({ ...unbound, installation_id: '0b9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c' }, key.privateKey);
    expect(verifyLicence(installation, [key.publicKey]).binding).toEqual({ kind: 'installation', id: '0b9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c' });
    // An unbound document signed by hand (not through signLicence) is still refused.
    const handSigned = { ...unbound, key_id: key.keyId, signature: '' };
    handSigned.signature = `ed25519:${sign(null, Buffer.from(licenceSigningPayload(handSigned)), key.privateKey).toString('base64')}`;
    const error = licenceError(() => verifyLicence(handSigned, [key.publicKey]));
    expect(error.code).toBe('binding');
  });

  it('refuses signing keys that are not Ed25519 private keys, and rejected key ids', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    expect(licenceError(() => signLicence(UNSIGNED, rsa)).code).toBe('signing_key');
    expect(licenceError(() => signLicence(UNSIGNED, key.publicKeyPem)).code).toBe('signing_key');
    expect(licenceError(() => signLicence(UNSIGNED, key.privateKey, { rejectKeyIds: [key.keyId] })).code).toBe('signing_key');
  });
});

describe('development licences (G.3)', () => {
  const pub = readFileSync(path.join(DEV_KEYS_DIR, 'licence-signing.pub'), 'utf8');
  const files = readdirSync(DEV_LICENCES_DIR).filter((f) => f.endsWith('.json')).sort();
  const orgs: Record<string, [string, string]> = {
    NDT: ['PT Nusantara Digital Teknologi', '00000000-0000-4000-8000-00000000a001'],
    BSD: ['PT Bank Sentosa Digital', '00000000-0000-4000-8000-00000000a002'],
    RMN: ['RS Medika Nusantara', '00000000-0000-4000-8000-00000000a003'],
    TST: ['Test Organisation', '00000000-0000-4000-8000-00000000a004'],
  };

  it('are the four licences of the demo and test organisations', () => {
    expect(files).toEqual(['LIC-DEMO-BSD.json', 'LIC-DEMO-NDT.json', 'LIC-DEMO-RMN.json', 'LIC-DEMO-TST.json']);
  });

  for (const file of files) {
    it(`${file} is signed with the development licence key and bound to its organisation`, () => {
      const text = readFileSync(path.join(DEV_LICENCES_DIR, file), 'utf8');
      expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
      const { document, binding, keyId: id } = verifyLicence(text, [pub]);
      const slug = file.slice('LIC-DEMO-'.length, -'.json'.length);
      const [name, orgId] = orgs[slug] as [string, string];
      expect(id).toBe(keyId(pub));
      expect(binding).toEqual({ kind: 'organization', id: orgId });
      expect(document).toMatchObject({
        license_id: `LIC-DEMO-${slug}`, organization: name, organization_id: orgId, valid_from: '2026-04-01', valid_until: '2027-03-31',
        grace_days: 30, frameworks: ['ISO27001', 'ISO9001', 'ISO22301', 'ISO37001'], max_management_systems: 10, max_users: 150,
        storage_adapters: ['managed_vault', 'm365', 'google_drive', 'smb'],
        features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'],
      });
      expect(document.trial).toBeUndefined();
      expect(document.installation_id).toBeUndefined();
    });

    it(`${file} is refused when development keys are rejected`, () => {
      const error = licenceError(() => verifyLicence(readFileSync(path.join(DEV_LICENCES_DIR, file)), [pub], { rejectKeyIds: DEV_KEY_IDS }));
      expect(error.code).toBe('rejected_key');
      expect(error.message).toMatch(/development key/);
    });
  }
});
