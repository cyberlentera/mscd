#!/usr/bin/env node
// `npm run seed:demo` (build plan G.1): bootstrap, migrate and seed the demo data into the database of
// MSCD_DATABASE_URL (default: the developer stack through profiles/demo.yaml).
//
// Steps:
//   1. node tools/scripts/ensure-built.mjs, when it exists (WP-14: builds @mscd/shared, @mscd/pack-tools and the
//      development packs when they are missing or stale);
//   2. npm run build -w @mscd/server;
//   3. mscd-server db bootstrap, when an administrator URL is available: MSCD_DATABASE_ADMIN_URL (or _FILE), or the
//      default demo profile, whose database.admin_url_file reaches the developer stack (there it changes nothing,
//      because the stack ran the same bootstrap at its first start);
//   4. mscd-server migrate;
//   5. mscd-server seed demo [arguments of this script, for example --reset].
// MSCD_PROFILE_FILE defaults to apps/server/profiles/demo.yaml.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '../..');
const defaultProfile = !process.env.MSCD_PROFILE_FILE;
const env = { ...process.env, MSCD_PROFILE_FILE: process.env.MSCD_PROFILE_FILE || path.join(serverDir, 'profiles/demo.yaml') };

function step(title, command, args, options = {}) {
  process.stdout.write(`\nseed:demo: ${title}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit', env, cwd: repoRoot, ...options });
  if (result.error) {
    process.stderr.write(`seed:demo: ${title} could not start: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(`seed:demo: ${title} failed (exit ${result.status ?? result.signal})\n`);
    process.exit(result.status ?? 1);
  }
}

const ensureBuilt = path.join(repoRoot, 'tools/scripts/ensure-built.mjs');
if (existsSync(ensureBuilt)) step('build shared packages and development packs', process.execPath, [ensureBuilt]);
step('build the server', 'npm', ['run', 'build', '-w', '@mscd/server']);

const main = path.join(serverDir, 'dist/main.js');
const adminConfigured = defaultProfile || Boolean(env.MSCD_DATABASE_ADMIN_URL || env.MSCD_DATABASE_ADMIN_URL_FILE);
if (adminConfigured) {
  step('db bootstrap', process.execPath, [main, 'db', 'bootstrap']);
} else {
  process.stdout.write('\nseed:demo: db bootstrap skipped (set MSCD_DATABASE_ADMIN_URL to run it)\n');
}
step('migrate', process.execPath, [main, 'migrate']);
step('seed demo', process.execPath, [main, 'seed', 'demo', ...process.argv.slice(2)]);
