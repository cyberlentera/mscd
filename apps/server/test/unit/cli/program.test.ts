import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/program';

const run = promisify(execFile);
const SERVER_DIR = path.resolve(__dirname, '../../..');

function names(command: Command): string[] {
  return command.commands.map((c) => c.name());
}

describe('mscd-server command line (D-01)', () => {
  const program = buildProgram();

  it('has the four run modes and the admin commands', () => {
    expect(names(program)).toEqual(['api', 'worker', 'storage-gateway', 'migrate', 'db', 'tenant', 'packs', 'keys', 'admin', 'seed']);
  });

  it('has the sub-commands of D-01', () => {
    const sub = (name: string) => names(program.commands.find((c) => c.name() === name)!);
    expect(sub('db')).toEqual(['bootstrap']);
    expect(sub('tenant')).toEqual(['create', 'verify-domain']);
    expect(sub('packs')).toEqual(['install']);
    expect(sub('keys')).toEqual(['generate', 'rewrap', 'rotate-gateway-token']);
    expect(sub('admin')).toEqual(['create-user']);
    expect(sub('seed')).toEqual(['demo']);
  });
});

describe('gen-build-info.mjs (B.4, D-16)', () => {
  let dir: string;
  const script = path.join(SERVER_DIR, 'scripts/gen-build-info.mjs');
  const generate = (out: string, env: Record<string, string>) =>
    run(process.execPath, [script, '--out', out], { env: { ...process.env, MSCD_TRUSTED_KEYS_DIR: '', ...env } });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mscd-build-info-'));
    for (const name of ['licence-rehearsal', 'pack-rehearsal', 'anchor-rehearsal']) {
      const { publicKey } = generateKeyPairSync('ed25519');
      await writeFile(path.join(dir, `${name}.pub`), publicKey.export({ type: 'spki', format: 'pem' }));
    }
    await writeFile(path.join(dir, 'notes.txt'), 'not a key');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('fails a release build without a trusted keys folder', async () => {
    await expect(generate(path.join(dir, 'a.ts'), { MSCD_BUILD_FLAVOR: 'release', MSCD_TRUSTED_KEYS_DIR: '/nonexistent' })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/not a folder/),
    });
    await expect(generate(path.join(dir, 'b.ts'), { MSCD_BUILD_FLAVOR: 'release' })).rejects.toMatchObject({
      stderr: expect.stringMatching(/MSCD_TRUSTED_KEYS_DIR is required/),
    });
  });

  it('fails a release build without a licence or a pack key, or with a key that is not Ed25519', async () => {
    const onlyAnchor = await mkdtemp(path.join(dir, 'anchor-only-'));
    await writeFile(path.join(onlyAnchor, 'anchor-x.pub'), await readFile(path.join(dir, 'anchor-rehearsal.pub')));
    await expect(generate(path.join(dir, 'c.ts'), { MSCD_BUILD_FLAVOR: 'release', MSCD_TRUSTED_KEYS_DIR: onlyAnchor })).rejects.toMatchObject({
      stderr: expect.stringMatching(/no licence-\*\.pub key/),
    });
    const rsa = await mkdtemp(path.join(dir, 'rsa-'));
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    await writeFile(path.join(rsa, 'licence-rsa.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
    await expect(generate(path.join(dir, 'd.ts'), { MSCD_BUILD_FLAVOR: 'release', MSCD_TRUSTED_KEYS_DIR: rsa })).rejects.toMatchObject({
      stderr: expect.stringMatching(/not an Ed25519 public key/),
    });
  });

  it('writes the flavour, version, revision and the trusted keys of a release build', async () => {
    const out = path.join(dir, 'release.ts');
    await generate(out, { MSCD_BUILD_FLAVOR: 'release', MSCD_TRUSTED_KEYS_DIR: dir, MSCD_VERSION: '2.0.1', MSCD_REVISION: 'abc123' });
    const text = await readFile(out, 'utf8');
    expect(text).toContain('export const BUILD_FLAVOR: BuildFlavor = "release";');
    expect(text).toContain('export const VERSION = "2.0.1";');
    expect(text).toContain('export const REVISION = "abc123";');
    const kinds = [...text.matchAll(/\{ kind: "(\w+)", keyId: "([0-9a-f]{16})"/g)].map((m) => m[1]);
    expect(kinds).toEqual(['anchor', 'licence', 'pack']);
  });

  it('rejects an unknown flavour', async () => {
    await expect(generate(path.join(dir, 'e.ts'), { MSCD_BUILD_FLAVOR: 'debug' })).rejects.toMatchObject({
      stderr: expect.stringMatching(/must be dev or release/),
    });
  });
});
