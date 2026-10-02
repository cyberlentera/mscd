#!/usr/bin/env node
// The stack of the API end-to-end project (build plan J.6), started by Playwright as the `webServer` of
// playwright.api.config.js and stopped by it (SIGTERM) when the run ends:
//
//   1. node tools/scripts/ensure-built.mjs (shared packages and development packs), then the server and the mock
//      providers are built (`tsc -b` is incremental, so an unchanged tree builds in seconds);
//   2. PostgreSQL, SeaweedFS and Mailpit containers on random host ports, labelled mscd.test=true;
//   3. db bootstrap, migrate and `seed demo` into the template database mscd_e2e_tpl, then mscd_e2e is created from it
//      (the database the api uses; `POST /test/reset` recreates it from the template before every test);
//   4. mock providers (4310) with the demo fixtures, storage gateway (4311, TLS off) and api (3174) from
//      apps/server/dist with profiles/test.yaml, test.endpoints_enabled, test.template_database and the
//      administrator URL file; the api's SMTP goes to Mailpit;
//   5. the web app built with VITE_DATA_SOURCE=api into a temporary folder and served by `vite preview` on 4174, which
//      forwards /api to the api.
//
// No worker runs: jobs stay queued, and the suite asserts command results, not job effects. The addresses of the
// run (Mailpit API, database) are written to node_modules/.cache/mscd/e2e-api-stack.json for the specs. On SIGTERM,
// SIGINT, a failed start, the end of a child process or the end of the process that started the stack, everything is
// stopped and every container is removed; containers of an earlier stack that was killed are removed at start.
//
// Environment: MSCD_TEST_CONTAINER_PREFIX names the containers <prefix>e2e-<service>-<random> (default "mscd-");
// MSCD_TEST_PG_IMAGE replaces postgres:16.15-alpine; E2E_STACK_SKIP_BUILD=1 skips step 1 apart from ensure-built.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB, '../..');
const SERVER = path.join(ROOT, 'apps/server');
const MAIN = path.join(SERVER, 'dist/main.js');
const TEST_PROFILE = path.join(SERVER, 'profiles/test.yaml');
export const STATE_FILE = path.join(ROOT, 'node_modules/.cache/mscd/e2e-api-stack.json');

export const PORTS = { web: 4174, api: 3174, mock: 4310, gateway: 4311 };
const IMAGES = {
  postgres: process.env.MSCD_TEST_PG_IMAGE || 'postgres:16.15-alpine',
  seaweed: 'chrislusf/seaweedfs:4.48',
  mailpit: 'axllent/mailpit:v1.31.3',
};
const VITE = path.join(path.dirname(createRequire(path.join(WEB, 'package.json')).resolve('vite/package.json')), 'bin/vite.js');
const TEMPLATE_DB = 'mscd_e2e_tpl';
const APP_DB = 'mscd_e2e';
/** Development role passwords (R-11), the same as the developer stack and the integration tests. */
const ROLE_PASSWORDS = { mscd_migrator: 'migrator-dev', mscd_app: 'app-dev', mscd_pack_installer: 'pack-dev' };
/** Leftovers of a killed run are removed by later test runs once this old (R-06). */
const CONTAINER_LIFETIME_MS = 3 * 60 * 60 * 1000;
const PREFIX = process.env.MSCD_TEST_CONTAINER_PREFIX || 'mscd-';
const RUN_ID = randomBytes(4).toString('hex');

const containers = [];
const children = [];
let work = null;
let stopping = false;

function log(message) {
  process.stdout.write(`e2e-api stack: ${message}\n`);
}

function run(title, command, args, options = {}) {
  log(title);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
    throw new Error(`${title} failed (${result.error?.message ?? `exit ${result.status ?? result.signal}`})\n${output}`);
  }
  return result.stdout;
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Creates a container with a random host port for each container port, starts it and returns its host ports. */
function startContainer(service, image, ports, args = [], command = [], files = []) {
  const name = `${PREFIX}e2e-${service}-${RUN_ID}`;
  const publish = ports.flatMap((p) => ['-p', `127.0.0.1::${p}`]);
  const labels = ['--label', 'mscd.test=true', '--label', `mscd.test.expires=${Date.now() + CONTAINER_LIFETIME_MS}`, '--label', `mscd.e2e.run=${RUN_ID}`, '--label', `mscd.e2e.pid=${process.pid}`];
  const id = docker(['create', '--name', name, ...labels, ...publish, ...args, image, ...command]);
  containers.push(id);
  for (const [source, target] of files) docker(['cp', source, `${id}:${target}`]);
  docker(['start', id]);
  const mapped = {};
  for (const p of ports) {
    const line = docker(['port', id, `${p}/tcp`]).split('\n').find((l) => l.startsWith('127.0.0.1:')) ?? '';
    mapped[p] = Number(line.split(':').pop());
    if (!mapped[p]) throw new Error(`No host port for ${service} ${p}`);
  }
  log(`${service} started as ${name}`);
  return mapped;
}

async function waitFor(title, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error.message;
    }
    if (stopping) throw new Error('stopping');
    if (Date.now() > deadline) throw new Error(`${title} did not become ready within ${timeoutMs / 1000} s${last ? `: ${last}` : ''}`);
    await sleep(500);
  }
}

async function httpOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  await response.arrayBuffer();
  return response.ok;
}

const EXPECTED_NOISE = /^PostgreSQL idle client error: terminating connection due to administrator command$/;

/** A child process whose output is prefixed; its end before the stack stops ends the stack. */
function startChild(name, command, args, env, cwd = ROOT) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const forward = (stream, target) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        // Every reset ends the idle connections of the api's pool (DROP DATABASE ... WITH (FORCE)); expected noise.
        if (EXPECTED_NOISE.test(line)) continue;
        target.write(`[${name}] ${line}\n`);
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    process.stderr.write(`e2e-api stack: ${name} ended (${signal ?? `exit ${code}`}); stopping the stack\n`);
    void stop(1);
  });
  return child;
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (children.some((c) => c.exitCode === null && c.signalCode === null) && Date.now() < deadline) await sleep(100);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (containers.length > 0) {
    try {
      docker(['rm', '-f', '-v', ...containers]);
      log(`removed ${containers.length} container(s)`);
    } catch (error) {
      process.stderr.write(`e2e-api stack: removing the containers failed: ${error.message}\n`);
    }
  }
  if (work) rmSync(work, { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
  process.exit(code);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void stop(0));
// When Playwright goes away, its end of the output pipes closes: writes fail with EPIPE, which must not end this
// process before the containers are removed.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => undefined);
process.on('uncaughtException', (error) => {
  try {
    process.stderr.write(`e2e-api stack: ${error.stack ?? error.message}\n`);
  } catch {
    // the output may be gone
  }
  void stop(1);
});

/** Parent and grandparent (Playwright runs the command through a shell); the stack stops when either ends. */
function ancestors() {
  const pids = [process.ppid];
  try {
    const stat = readFileSync(`/proc/${process.ppid}/stat`, 'utf8');
    const grandparent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (grandparent > 1) pids.push(grandparent);
  } catch {
    // no /proc: only the parent is watched
  }
  return pids;
}
const WATCHED = ancestors();
setInterval(() => {
  for (const pid of WATCHED) {
    try {
      process.kill(pid, 0);
    } catch {
      log(`process ${pid} that started the stack has ended; stopping`);
      void stop(1);
      return;
    }
  }
}, 2000).unref();

function pgUrl(port, database, user = 'postgres', password) {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

/** True while process `pid` of this host exists (a signal 0 to a process of another user also proves it exists). */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Containers of an earlier API E2E stack that was killed before it could remove them. A container is a leftover when
 * its `mscd.test.expires` time has passed or the stack process named by `mscd.e2e.pid` no longer exists; containers
 * of a stack that is still running (for example in its build and seed phase) are kept.
 */
function removeLeftovers() {
  let rows = '';
  try {
    rows = docker(['ps', '-a', '--filter', 'label=mscd.e2e.run', '--format', '{{.ID}}\t{{.Label "mscd.test.expires"}}\t{{.Label "mscd.e2e.pid"}}']);
  } catch {
    return;
  }
  const now = Date.now();
  const list = rows
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split('\t'))
    .filter(([, expires, pid]) => !(Number(expires) > now) || !alive(Number(pid)))
    .map(([id]) => id);
  if (list.length === 0) return;
  docker(['rm', '-f', '-v', ...list]);
  log(`removed ${list.length} container(s) left over by an earlier run`);
}

async function main() {
  removeLeftovers();
  // 1. Builds.
  run('ensure-built (shared packages and development packs)', process.execPath, [path.join(ROOT, 'tools/scripts/ensure-built.mjs'), '--quiet']);
  if (process.env.E2E_STACK_SKIP_BUILD !== '1') {
    run('build the server', 'npm', ['run', 'build', '-w', '@mscd/server']);
    run('build the mock providers', 'npm', ['run', 'build', '-w', '@mscd/mock-providers']);
  }
  work = mkdtempSync(path.join(tmpdir(), 'mscd-e2e-api-'));

  // 2. Containers.
  const adminPassword = randomBytes(12).toString('hex');
  const pg = startContainer('postgres', IMAGES.postgres, [5432], ['-e', `POSTGRES_PASSWORD=${adminPassword}`, '-e', 'POSTGRES_DB=postgres']);
  const s3Access = readFileSync(path.join(SERVER, 'test/fixtures/secrets/s3.access'), 'utf8').trim();
  const s3Secret = readFileSync(path.join(SERVER, 'test/fixtures/secrets/s3.secret'), 'utf8').trim();
  const s3Config = path.join(work, 's3.json');
  writeFileSync(
    s3Config,
    JSON.stringify({ identities: [{ name: 'mscd', credentials: [{ accessKey: s3Access, secretKey: s3Secret }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] }),
  );
  const seaweed = startContainer('seaweedfs', IMAGES.seaweed, [8333], [], ['mini', '-dir=/data', '-s3.config=/etc/seaweedfs/s3.json', '-bucket=mscd-vault'], [
    [s3Config, '/etc/seaweedfs/s3.json'],
  ]);
  const mail = startContainer('mailpit', IMAGES.mailpit, [1025, 8025]);
  const mailApi = `http://127.0.0.1:${mail[8025]}/api/v1`;
  const s3Endpoint = `http://127.0.0.1:${seaweed[8333]}`;

  const admin = (database) => pgUrl(pg[5432], database, 'postgres', adminPassword);
  await waitFor('PostgreSQL', async () => {
    const out = spawnSync('docker', ['exec', containers[0], 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'], { encoding: 'utf8' });
    return out.status === 0;
  });
  await waitFor('Mailpit', () => httpOk(`${mailApi}/messages?limit=1`));
  // SeaweedFS answers the S3 port once the bucket exists; an anonymous request gets 403 from a ready server.
  await waitFor('SeaweedFS', async () => {
    const response = await fetch(`${s3Endpoint}/mscd-vault`, { signal: AbortSignal.timeout(3000) });
    await response.arrayBuffer();
    return response.status < 500;
  });

  // 3. Template database and the database of the api.
  const psql = (database, sql) =>
    run(`psql ${database}: ${sql.split('\n')[0].slice(0, 60)}`, 'docker', ['exec', '-i', containers[0], 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-c', sql]);
  await waitFor('PostgreSQL connections', async () => {
    psql('postgres', 'select 1');
    return true;
  }, 60_000);
  psql('postgres', `CREATE DATABASE ${TEMPLATE_DB}`);
  const urlsOf = (database) => ({
    MSCD_DATABASE_ADMIN_URL: admin(database),
    MSCD_DATABASE_MIGRATOR_URL: pgUrl(pg[5432], database, 'mscd_migrator', ROLE_PASSWORDS.mscd_migrator),
    MSCD_DATABASE_URL: pgUrl(pg[5432], database, 'mscd_app', ROLE_PASSWORDS.mscd_app),
    MSCD_DATABASE_PACK_URL: pgUrl(pg[5432], database, 'mscd_pack_installer', ROLE_PASSWORDS.mscd_pack_installer),
  });
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) if (key.startsWith('MSCD_') && key !== 'MSCD_BUILD_CA') delete baseEnv[key];
  const serverEnv = (database, extra = {}) => ({
    ...baseEnv,
    MSCD_PROFILE_FILE: TEST_PROFILE,
    ...urlsOf(database),
    MSCD__OBSERVABILITY__METRICS_PORT: 'null',
    MSCD__GATEWAY__VAULT__ENDPOINT: s3Endpoint,
    MSCD__MAIL__SMTP__HOST: '127.0.0.1',
    MSCD__MAIL__SMTP__PORT: String(mail[1025]),
    ...extra,
  });
  run('db bootstrap', process.execPath, [MAIN, 'db', 'bootstrap'], { env: serverEnv(TEMPLATE_DB) });
  run('migrate', process.execPath, [MAIN, 'migrate'], { env: serverEnv(TEMPLATE_DB) });
  run('seed demo', process.execPath, [MAIN, 'seed', 'demo'], { env: serverEnv(TEMPLATE_DB) });
  psql('postgres', `CREATE DATABASE ${APP_DB} TEMPLATE ${TEMPLATE_DB}`);
  // Database privileges are not copied by CREATE DATABASE ... TEMPLATE (C.2).
  psql('postgres', `GRANT CONNECT, CREATE ON DATABASE ${APP_DB} TO mscd_migrator; GRANT CONNECT ON DATABASE ${APP_DB} TO mscd_app, mscd_pack_installer`);
  const adminUrlFile = path.join(work, 'db-admin.url');
  writeFileSync(adminUrlFile, admin('postgres'), { mode: 0o600 });

  // 4. Mock providers, storage gateway and api.
  startChild('mock-providers', process.execPath, [path.join(ROOT, 'tools/mock-providers/dist/server.js'), '--port', String(PORTS.mock), '--host', '127.0.0.1', '--fixtures', 'demo'], baseEnv);
  await waitFor('mock providers', () => httpOk(`http://127.0.0.1:${PORTS.mock}/_admin/health`));
  startChild('storage-gateway', process.execPath, [MAIN, 'storage-gateway'], serverEnv(APP_DB, { MSCD__GATEWAY__PORT: String(PORTS.gateway) }));
  await waitFor('storage gateway', () => httpOk(`http://127.0.0.1:${PORTS.gateway}/healthz`));
  startChild(
    'api',
    process.execPath,
    [MAIN, 'api'],
    serverEnv(APP_DB, {
      MSCD__HTTP__PORT: String(PORTS.api),
      MSCD__HTTP__PUBLIC_URL: `http://localhost:${PORTS.web}`,
      MSCD__STORAGE__GATEWAY__URL: `http://127.0.0.1:${PORTS.gateway}`,
      MSCD__TEST__ENDPOINTS_ENABLED: 'true',
      MSCD__TEST__TEMPLATE_DATABASE: TEMPLATE_DB,
      MSCD__TEST__ADMIN_DATABASE_URL_FILE: adminUrlFile,
    }),
  );
  await waitFor('api', () => httpOk(`http://127.0.0.1:${PORTS.api}/readyz`));

  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ runId: RUN_ID, mailApi, web: `http://localhost:${PORTS.web}`, api: `http://127.0.0.1:${PORTS.api}`, mock: `http://127.0.0.1:${PORTS.mock}` }, null, 2),
  );

  // 5. The web app in API mode.
  const dist = path.join(work, 'web-dist');
  const webEnv = { ...baseEnv, VITE_DATA_SOURCE: 'api', VITE_API_TARGET: `http://127.0.0.1:${PORTS.api}` };
  run('build the web app (VITE_DATA_SOURCE=api)', process.execPath, [VITE, 'build', '--outDir', dist, '--emptyOutDir'], { cwd: WEB, env: webEnv });
  startChild('web', process.execPath, [VITE, 'preview', '--port', String(PORTS.web), '--strictPort', '--outDir', dist], webEnv, WEB);
  log(`ready: web http://localhost:${PORTS.web}, api ${PORTS.api}, mock providers ${PORTS.mock}, gateway ${PORTS.gateway}, Mailpit ${mailApi}`);
}

main().catch((error) => {
  if (!stopping) process.stderr.write(`e2e-api stack: ${error.stack ?? error.message}\n`);
  void stop(1);
});
