#!/usr/bin/env node
// Builds the git-ignored outputs that scripts and tests need (build plan G.1), only when they are missing or older
// than their sources:
//
//   packages/shared/dist       npm run build -w @mscd/shared
//   packages/pack-tools/dist   npm run build -w @mscd/pack-tools
//   packs/dist/*.pack          mscd-pack build-all with the development pack key (packages/pack-tools/dev-keys)
//
// Used by `npm run seed:demo`, the integration test setup (apps/server/test/setup/global-db.ts), the API E2E stack
// and the full-stack smoke test. A lock file serialises concurrent runs, so two test runs never build into the same
// folder at once; pack files are written atomically by build-all.
//
// Usage: node tools/scripts/ensure-built.mjs [--quiet] [--check]
//   --check   report what is missing or stale and exit 1 when anything is (nothing is built)
//   --quiet   print only builds and errors
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCK_FILE = path.join(ROOT, 'node_modules', '.cache', 'mscd', 'ensure-built.lock');
/** A lock older than this is left over from a killed run and is taken over. */
const STALE_LOCK_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 5 * 60 * 1000;

const USAGE = `Usage: node tools/scripts/ensure-built.mjs [--quiet] [--check]

Builds @mscd/shared, @mscd/pack-tools and the development packs (packs/dist) when they are missing or older than
their sources.

  --check   report what is missing or stale and exit 1 when anything is (nothing is built)
  --quiet   print only builds and errors
  --help    show this text
`;

/** Newest modification time (ms) of the files under the given paths; directories are walked. 0 when none exist. */
export function newestMtime(paths) {
  let newest = 0;
  const visit = (file) => {
    let info;
    try {
      info = statSync(file);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(file)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        visit(path.join(file, entry));
      }
    } else if (info.isFile()) {
      newest = Math.max(newest, info.mtimeMs);
    }
  };
  for (const p of paths) visit(p);
  return newest;
}

/** Oldest modification time (ms) of the given files; 0 when one of them is missing. */
function oldestMtime(files) {
  let oldest = Infinity;
  for (const file of files) {
    try {
      oldest = Math.min(oldest, statSync(file).mtimeMs);
    } catch {
      return 0;
    }
  }
  return files.length === 0 ? 0 : oldest;
}

const rel = (p) => path.relative(ROOT, p) || '.';
const TSCONFIG_BASE = path.join(ROOT, 'tsconfig.base.json');

/** The pack files `build-all` writes: `<pack_id>-<pack_version>.pack` for each source folder. */
function expectedPackFiles() {
  const sources = path.join(ROOT, 'packs', 'sources');
  return readdirSync(sources, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const manifest = JSON.parse(readFileSync(path.join(sources, entry.name, 'manifest.json'), 'utf8'));
      return path.join(ROOT, 'packs', 'dist', `${manifest.pack_id}-${manifest.pack_version}.pack`);
    })
    .sort();
}

/** The build steps in dependency order. `stale()` returns a reason, or null when the outputs are current. */
export function steps() {
  const shared = path.join(ROOT, 'packages', 'shared');
  const packTools = path.join(ROOT, 'packages', 'pack-tools');
  const packToolsOutputs = ['index.js', 'index.d.ts', 'cli.js'].map((f) => path.join(packTools, 'dist', f));
  const signingKey = path.join(packTools, 'dev-keys', 'pack-signing.key');
  return [
    {
      name: '@mscd/shared',
      outputs: () => ['index.js', 'index.d.ts'].map((f) => path.join(shared, 'dist', f)),
      sources: () => [path.join(shared, 'src'), path.join(shared, 'package.json'), path.join(shared, 'tsconfig.build.json'), TSCONFIG_BASE],
      build: () => run('npm', ['run', 'build', '-w', '@mscd/shared']),
    },
    {
      name: '@mscd/pack-tools',
      outputs: () => packToolsOutputs,
      sources: () => [
        path.join(packTools, 'src'),
        path.join(packTools, 'package.json'),
        path.join(packTools, 'tsconfig.build.json'),
        TSCONFIG_BASE,
        path.join(shared, 'dist'),
      ],
      build: () => run('npm', ['run', 'build', '-w', '@mscd/pack-tools']),
    },
    {
      name: 'packs/dist',
      outputs: expectedPackFiles,
      sources: () => [path.join(ROOT, 'packs', 'sources'), signingKey, ...packToolsOutputs],
      build: () =>
        run(process.execPath, [
          path.join(packTools, 'dist', 'cli.js'),
          'build-all',
          '--sign-key-file',
          signingKey,
          '--out',
          path.join(ROOT, 'packs', 'dist'),
        ]),
    },
  ].map((step) => ({
    ...step,
    stale() {
      const outputs = step.outputs();
      const missing = outputs.filter((file) => !existsSync(file));
      if (missing.length > 0) return `missing ${missing.map(rel).join(', ')}`;
      const newestSource = newestMtime(step.sources());
      if (newestSource > oldestMtime(outputs)) return 'older than its sources';
      return null;
    },
  }));
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${command} ${args.join(' ')} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? result.signal})${output ? `:\n${output}` : ''}`);
  }
}

/** Takes the lock file (waiting for another run to finish); returns the release function. */
function acquireLock() {
  mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(LOCK_FILE, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(LOCK_FILE, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(LOCK_FILE).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    if (age > STALE_LOCK_MS) {
      rmSync(LOCK_FILE, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`another ensure-built run holds ${rel(LOCK_FILE)}; remove it if no build is running`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}

/** Brings every output up to date. Returns the names of the steps that were built. */
export function ensureBuilt({ log = (line) => process.stdout.write(`${line}\n`), quiet = false } = {}) {
  const built = [];
  let release = null;
  try {
    for (const step of steps()) {
      let reason = step.stale();
      if (reason === null) {
        if (!quiet) log(`ensure-built: ${step.name} up to date`);
        continue;
      }
      release ??= acquireLock();
      reason = step.stale(); // another run may have built it while this one waited for the lock
      if (reason === null) {
        if (!quiet) log(`ensure-built: ${step.name} up to date`);
        continue;
      }
      log(`ensure-built: building ${step.name} (${reason})`);
      step.build();
      // An incremental build that found nothing to change leaves the outputs untouched; mark them as current.
      const now = new Date();
      for (const file of step.outputs()) if (existsSync(file)) utimesSync(file, now, now);
      const after = step.stale();
      if (after !== null) throw new Error(`${step.name} is still not current after the build (${after})`);
      built.push(step.name);
    }
  } finally {
    release?.();
  }
  return built;
}

function main(args) {
  let check = false;
  let quiet = false;
  for (const arg of args) {
    if (arg === '--check') check = true;
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`ensure-built: unknown option ${arg}\n\n${USAGE}`);
      return 2;
    }
  }
  if (check) {
    const stale = steps()
      .map((step) => [step.name, step.stale()])
      .filter(([, reason]) => reason !== null);
    for (const [name, reason] of stale) process.stdout.write(`ensure-built: ${name} needs a build (${reason})\n`);
    if (stale.length === 0 && !quiet) process.stdout.write('ensure-built: everything is up to date\n');
    return stale.length === 0 ? 0 : 1;
  }
  ensureBuilt({ quiet });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ensure-built: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
