// The CLI `mscd-pack`, run in process: exit codes 0 (success), 1 (failure) and 2 (usage), and the files it writes.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/commands.js';
import { DEV_KEY_IDS, keyId, verifyLicence, verifyPack } from '../src/index.js';
import { DEV_KEYS_DIR, DEV_LICENCES_DIR, SOURCES_DIR, tempDir } from './helpers.js';

function run(...argv: string[]): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = runCli(argv, { stdout: (t) => { out += t; }, stderr: (t) => { err += t; } });
  return { code, out, err };
}

const devPackKey = path.join(DEV_KEYS_DIR, 'pack-signing.key');
const devPackPub = path.join(DEV_KEYS_DIR, 'pack-signing.pub');
const devLicencePub = path.join(DEV_KEYS_DIR, 'licence-signing.pub');

describe('mscd-pack', () => {
  it('prints help with exit 0 and answers usage errors with exit 2', () => {
    expect(run('--help').code).toBe(0);
    expect(run('licence', 'verify', '--help').code).toBe(0);
    expect(run().code).toBe(2);
    const missing = run('verify', 'x.pack');
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/--trusted/);
    expect(run('frobnicate').code).toBe(2);
  });

  it('keygen writes an Ed25519 pair, refuses to overwrite without --force and checks the name', () => {
    const dir = path.join(tempDir(), 'keys');
    const first = run('keygen', '--out', dir, '--name', 'pack-rehearsal');
    expect(first.code).toBe(0);
    const pub = readFileSync(path.join(dir, 'pack-rehearsal.pub'), 'utf8');
    expect(first.out).toContain(`key ${keyId(pub)}`);
    expect(statSync(path.join(dir, 'pack-rehearsal.key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(dir, 'pack-rehearsal.key'), 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const again = run('keygen', '--out', dir, '--name', 'pack-rehearsal');
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/exists; pass --force/);
    expect(run('keygen', '--out', dir, '--name', 'pack-rehearsal', '--force').code).toBe(0);
    expect(readFileSync(path.join(dir, 'pack-rehearsal.pub'), 'utf8')).not.toBe(pub);
    expect(run('keygen', '--out', dir, '--name', '../escape').code).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['pack-rehearsal.key', 'pack-rehearsal.pub']);
  });

  it('build, build-all and verify', () => {
    const out = tempDir();
    const one = run('build', path.join(SOURCES_DIR, 'ISO27001-2022'), '--sign-key-file', devPackKey, '--out', out);
    expect(one.code).toBe(0);
    expect(one.out).toMatch(/ISO27001-2022-1\.2\.0\.pack sha256 [0-9a-f]{64} key [0-9a-f]{16} \(development key\)/);
    const all = run('build-all', '--sign-key-file', devPackKey, '--out', out);
    expect(all.code).toBe(0);
    expect(all.out).toContain('6 packs signed with key');
    const packs = readdirSync(out).filter((f) => f.endsWith('.pack')).sort();
    expect(packs).toHaveLength(6);
    for (const file of packs) {
      const result = run('verify', path.join(out, file), '--trusted', devPackPub);
      expect(result.code, result.err).toBe(0);
      expect(result.out).toMatch(/^OK .* signed with key [0-9a-f]{16} \(development key\)\n {2}requirements \d+/);
    }
    const iso = path.join(out, 'ISO27001-2022-1.2.0.pack');
    expect(run('verify', iso, '--trusted', devLicencePub, devPackPub).code).toBe(0);
    const wrong = run('verify', iso, '--trusted', devLicencePub);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/not a trusted pack key/);
    const rejected = run('verify', iso, '--trusted', devPackPub, '--reject-dev-keys');
    expect(rejected.code).toBe(1);
    expect(rejected.err).toMatch(/development key/);
    expect(run('verify', path.join(out, 'missing.pack'), '--trusted', devPackPub).err).toMatch(/cannot read pack .*ENOENT/);
    expect(run('verify', iso, '--trusted', path.join(DEV_KEYS_DIR, 'README.md')).code).toBe(1);
  });

  it('build-all --reject-dev-keys refuses the development key and accepts another', () => {
    const out = tempDir();
    const refused = run('build-all', '--sign-key-file', devPackKey, '--out', out, '--reject-dev-keys');
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/development key/);
    expect(readdirSync(out)).toEqual([]);
    const keys = tempDir();
    expect(run('keygen', '--out', keys, '--name', 'pack-release').code).toBe(0);
    const built = run('build-all', '--sign-key-file', path.join(keys, 'pack-release.key'), '--out', out, '--reject-dev-keys', '--sources', SOURCES_DIR);
    expect(built.code, built.err).toBe(0);
    const pub = readFileSync(path.join(keys, 'pack-release.pub'));
    const pack = verifyPack(readFileSync(path.join(out, 'ISO22301-2019-1.0.0.pack')), [pub], { rejectKeyIds: DEV_KEY_IDS });
    expect(pack.keyId).toBe(keyId(pub));
  });

  it('licence sign and licence verify', () => {
    const dir = tempDir();
    const keys = path.join(dir, 'keys');
    expect(run('keygen', '--out', keys, '--name', 'licence-test').code).toBe(0);
    const source = path.join(dir, 'licence.json');
    writeFileSync(source, JSON.stringify({
      license_id: 'LIC-CLI', organization: 'Client A', installation_id: '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c', valid_from: '2026-10-01',
      valid_until: '2027-09-30', grace_days: 30, frameworks: ['ISO27001'], max_management_systems: 1, max_users: 10,
      storage_adapters: ['managed_vault'], features: [],
    }));
    const printed = run('licence', 'sign', source, '--key-file', path.join(keys, 'licence-test.key'));
    expect(printed.code).toBe(0);
    expect(JSON.parse(printed.out).signature).toMatch(/^ed25519:/);
    const signedFile = path.join(dir, 'signed.json');
    const written = run('licence', 'sign', source, '--key-file', path.join(keys, 'licence-test.key'), '--out', signedFile);
    expect(written.code).toBe(0);
    expect(readFileSync(signedFile, 'utf8')).toBe(printed.out);
    const verified = run('licence', 'verify', signedFile, '--trusted', path.join(keys, 'licence-test.pub'));
    expect(verified.code, verified.err).toBe(0);
    expect(verified.out).toMatch(/^OK .*LIC-CLI for Client A, bound to installation 6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c/);
    writeFileSync(signedFile, readFileSync(signedFile, 'utf8').replace('"max_users": 10', '"max_users": 11'));
    const tampered = run('licence', 'verify', signedFile, '--trusted', path.join(keys, 'licence-test.pub'));
    expect(tampered.code).toBe(1);
    expect(tampered.err).toMatch(/^mscd-pack licence verify: licence LIC-CLI: the signature does not match/);
    const refused = run('licence', 'sign', source, '--key-file', path.join(DEV_KEYS_DIR, 'licence-signing.key'), '--reject-dev-keys');
    expect(refused.code).toBe(1);
  });

  it('verifies the development licences and refuses them with --reject-dev-keys', () => {
    for (const file of readdirSync(DEV_LICENCES_DIR)) {
      const full = path.join(DEV_LICENCES_DIR, file);
      const ok = run('licence', 'verify', full, '--trusted', devLicencePub);
      expect(ok.code, ok.err).toBe(0);
      expect(ok.out).toContain('(development key)');
      expect(run('licence', 'verify', full, '--trusted', devLicencePub, '--reject-dev-keys').code).toBe(1);
      expect(run('licence', 'verify', full, '--trusted', devPackPub).code).toBe(1);
      expect(verifyLicence(readFileSync(full), [readFileSync(devLicencePub)]).document.license_id).toBe(file.replace('.json', ''));
    }
  });
});
