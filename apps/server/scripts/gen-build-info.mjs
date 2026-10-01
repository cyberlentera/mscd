#!/usr/bin/env node
// Writes src/generated/build-info.ts (build plan B.4, D-16, D-24). Run by the prebuild, pretypecheck, pretest
// and pretest:int scripts, so the trust anchors and the build flavour are fixed at build time and never come
// from runtime configuration.
//
// Environment:
//   MSCD_BUILD_FLAVOR      dev (default) or release
//   MSCD_VERSION           version string (default: apps/server/package.json version)
//   MSCD_REVISION          source revision (default: `git rev-parse --short=12 HEAD`, else "unknown")
//   MSCD_TRUSTED_KEYS_DIR  folder with licence-*.pub, pack-*.pub and anchor-*.pub (Ed25519, PEM).
//                          Required for release. Dev default: packages/pack-tools/dev-keys (missing gives no keys).
// Options:
//   --out <file>           write somewhere else (tests); default src/generated/build-info.ts
//
// Release flavour exits 1 when the folder is missing, holds no licence key or no pack key, holds a file that is
// not an Ed25519 public key, or holds a key whose id is listed in packages/pack-tools/dev-keys/dev-key-ids.json.
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '../..');
const devKeysDir = path.join(repoRoot, 'packages/pack-tools/dev-keys');
const KEY_FILE = /^(licence|pack|anchor)-[A-Za-z0-9._-]+\.pub$/;

function fail(message) {
  process.stderr.write(`gen-build-info: ${message}\n`);
  process.exit(1);
}

const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
const outFile = path.resolve(values.out ?? path.join(serverDir, 'src/generated/build-info.ts'));

const flavor = process.env.MSCD_BUILD_FLAVOR || 'dev';
if (flavor !== 'dev' && flavor !== 'release') {
  fail(`MSCD_BUILD_FLAVOR must be dev or release, got "${flavor}"`);
}

const pkg = JSON.parse(readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
const version = process.env.MSCD_VERSION || pkg.version;
if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version)) fail(`MSCD_VERSION "${version}" is not a valid version`);

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}
const revision = process.env.MSCD_REVISION || gitRevision();
if (!/^[0-9A-Za-z._-]{1,64}$/.test(revision)) fail(`MSCD_REVISION "${revision}" is not a valid revision`);

function migrationNames(folder) {
  const dir = path.join(serverDir, 'migrations', folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => name.slice(0, -'.sql'.length));
}

function keyIdOf(publicKey) {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

function readDevKeyIds() {
  const file = path.join(devKeysDir, 'dev-key-ids.json');
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string')) {
    fail(`${path.relative(repoRoot, file)} must be a JSON array of key ids`);
  }
  return parsed;
}

function readTrustedKeys(dir) {
  const keys = new Map();
  for (const name of readdirSync(dir).sort()) {
    const match = KEY_FILE.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    if (!statSync(file).isFile()) continue;
    let publicKey;
    try {
      publicKey = createPublicKey(readFileSync(file));
    } catch (error) {
      fail(`${file} is not a public key: ${error.message}`);
    }
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
      fail(`${file} is not an Ed25519 public key`);
    }
    const kind = match[1];
    const keyId = keyIdOf(publicKey);
    // The same key may appear under two names (for example pack-signing.pub and pack-dev.pub).
    keys.set(`${kind}:${keyId}`, {
      kind,
      keyId,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      file: name,
    });
  }
  return [...keys.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.keyId.localeCompare(b.keyId));
}

let keysDir = process.env.MSCD_TRUSTED_KEYS_DIR ? path.resolve(process.env.MSCD_TRUSTED_KEYS_DIR) : undefined;
let trustedKeys = [];
if (flavor === 'release') {
  if (!keysDir) fail('MSCD_TRUSTED_KEYS_DIR is required for a release build');
  if (!existsSync(keysDir) || !statSync(keysDir).isDirectory()) fail(`MSCD_TRUSTED_KEYS_DIR ${keysDir} is not a folder`);
  trustedKeys = readTrustedKeys(keysDir);
  if (!trustedKeys.some((k) => k.kind === 'licence')) fail(`${keysDir} holds no licence-*.pub key`);
  if (!trustedKeys.some((k) => k.kind === 'pack')) fail(`${keysDir} holds no pack-*.pub key`);
  const devKeyIds = new Set(readDevKeyIds());
  const dev = trustedKeys.filter((k) => devKeyIds.has(k.keyId));
  if (dev.length > 0) {
    fail(`${keysDir} holds development keys (${dev.map((k) => `${k.file} ${k.keyId}`).join(', ')}); release builds never trust them`);
  }
} else {
  keysDir ??= devKeysDir;
  if (existsSync(keysDir) && statSync(keysDir).isDirectory()) trustedKeys = readTrustedKeys(keysDir);
}

const platformMigrations = migrationNames('platform');
const lines = [
  '// Generated by apps/server/scripts/gen-build-info.mjs. Do not edit: run `npm run gen:build-info -w @mscd/server`.',
  '',
  "export type BuildFlavor = 'dev' | 'release';",
  "export type TrustedKeyKind = 'licence' | 'pack' | 'anchor';",
  '',
  'export interface TrustedKey {',
  '  readonly kind: TrustedKeyKind;',
  '  /** First 16 hexadecimal characters of the SHA-256 of the public key in DER (SPKI) form (E.8). */',
  '  readonly keyId: string;',
  '  readonly publicKeyPem: string;',
  '}',
  '',
  `export const BUILD_FLAVOR: BuildFlavor = ${JSON.stringify(flavor)};`,
  `export const VERSION = ${JSON.stringify(version)};`,
  `export const REVISION = ${JSON.stringify(revision)};`,
  '',
  '/** Platform migrations compiled into this build, oldest first; readiness needs the last one applied (C.3). */',
  `export const MIGRATIONS_EXPECTED: readonly string[] = ${JSON.stringify(platformMigrations)};`,
  '',
  '/** Migrations of every folder compiled into this build, oldest first. */',
  'export const MIGRATIONS_BY_FOLDER: Readonly<Record<"platform" | "ref" | "tenant", readonly string[]>> = {',
  `  platform: ${JSON.stringify(platformMigrations)},`,
  `  ref: ${JSON.stringify(migrationNames('ref'))},`,
  `  tenant: ${JSON.stringify(migrationNames('tenant'))},`,
  '};',
  '',
  '/** Trust anchors for licences, packs and audit anchors (D-16). Never configurable at runtime. */',
  'export const TRUSTED_KEYS: readonly TrustedKey[] = [',
  ...trustedKeys.map(
    (k) => `  { kind: ${JSON.stringify(k.kind)}, keyId: ${JSON.stringify(k.keyId)}, publicKeyPem: ${JSON.stringify(k.publicKeyPem)} },`,
  ),
  '];',
  '',
];
const content = lines.join('\n');

mkdirSync(path.dirname(outFile), { recursive: true });
// Unchanged content keeps the file's timestamp, so incremental TypeScript builds stay cached.
if (!existsSync(outFile) || readFileSync(outFile, 'utf8') !== content) writeFileSync(outFile, content);
process.stdout.write(
  `gen-build-info: ${path.relative(process.cwd(), outFile)} (flavour ${flavor}, version ${version}, revision ${revision}, ` +
    `${trustedKeys.length} trusted key(s), ${platformMigrations.length} platform migration(s))\n`,
);
