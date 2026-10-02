#!/usr/bin/env node
// Full-stack smoke test of MSCD (build plan J.9, WP-31).
//
// 1. Builds the mscd-server-demo, mscd-web and mscd-mock-providers images with the build CA (R-12), or uses the
//    existing images when SMOKE_SKIP_BUILD=1.
// 2. Starts the on-premise Compose file with the demo overlay as project mscd-smoke and waits for every service.
// 3. Runs the Playwright suite in tools/smoke/tests against the stack (Chromium maps the name keycloak to this host).
// 4. Removes the stack with its volumes (docker compose down -v), on success, on failure and on Ctrl-C.
//
// Usage: npm run test:smoke                      (root script: every setting from the environment)
//        node tools/smoke/run-smoke.mjs [options] [-- <Playwright arguments>]
//   --build-ca <file>   CA certificate of a TLS-inspecting proxy for the image builds
//                       (default: $MSCD_BUILD_CA; an empty file when unset)
//   --keep              leave the stack running after the tests (same as SMOKE_KEEP=1; remove it with --down)
//   --down              only remove the stack of an earlier --keep run, then exit
//   -h, --help          show this text
// Arguments after "--" go to "playwright test" (for example --headed or --trace on).
//
// Environment:
//   SMOKE_SKIP_BUILD=1      use existing images instead of building them
//   SMOKE_KEEP=1            leave the stack running after the tests
//   SMOKE_PROJECT           Compose project name (default mscd-smoke)
//   MSCD_VERSION            tag of the three images (default smoke)
//   MSCD_SERVER_DEMO_IMAGE, MSCD_IMAGE, MSCD_MOCK_IMAGE
//                           image repositories (defaults cyberlentera/mscd-server-demo, cyberlentera/mscd-web,
//                           cyberlentera/mscd-mock-providers)
//   MSCD_HTTP_PORT, MSCD_HTTPS_PORT, MSCD_KEYCLOAK_PORT, MSCD_MAILPIT_PORT
//                           published ports on 127.0.0.1 (defaults 18080, 18443, 18088, 18025); deploy/compose/.env
//                           is not read
//   MSCD_BUILD_CA, SMOKE_OUTPUT_DIR and --build-ca: a relative path is taken from the folder npm was started in
//   MSCD_SUBNET, MSCD_WEB_ADDRESS
//                           internal network and the fixed web address (default 172.31.250.0/24 and .10; when
//                           another Docker network already uses that range a free 172.31.x.0/24 is chosen)
//   SMOKE_OUTPUT_DIR        folder for build logs, Compose logs, the Playwright report and traces
//                           (default tools/smoke/test-results)
//
// Exit codes: 0 every check passed, 1 a build, the stack or a test failed, 2 wrong usage or a missing requirement.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { smokeSettings } from './lib/settings.mjs';
import { selfTest } from './lib/totp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const COMPOSE_DIR = path.join(ROOT, 'deploy/compose');
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.demo.yml'].map((f) => path.join(COMPOSE_DIR, f));
const DEFAULT_SUBNET_OCTET = 250;
const UP_TIMEOUT_SECONDS = 900;

class UsageError extends Error {}

function log(message) {
  process.stdout.write(`smoke: ${message}\n`);
}

function usage() {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const start = text.findIndex((l) => l.startsWith('// Full-stack'));
  const end = text.findIndex((l, i) => i > start && !l.startsWith('//'));
  return text.slice(start, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n';
}

function parseCommandLine(argv) {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const playwrightArgs = split === -1 ? [] : argv.slice(split + 1);
  const { values } = parseArgs({
    args: own,
    options: {
      'build-ca': { type: 'string' },
      keep: { type: 'boolean', default: false },
      down: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return { ...values, playwrightArgs };
}

/** Runs a command; resolves with its exit code. Output goes to the terminal or to `logFile`. */
function run(command, args, { env = process.env, cwd = ROOT, logFile = null, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const out = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', out || quiet ? 'pipe' : 'inherit', out || quiet ? 'pipe' : 'inherit'] });
    if (out) {
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
    } else if (quiet) {
      child.stdout.resume();
      child.stderr.resume();
    }
    current.add(child);
    child.on('error', (e) => {
      current.delete(child);
      reject(e);
    });
    child.on('close', (code, signal) => {
      current.delete(child);
      if (out) out.end();
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}

/** Runs a command and returns its standard output (throws on a non-zero exit). */
function capture(command, args, env = process.env) {
  const r = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

const current = new Set();

function tail(file, lines = 60) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// ---- preflight --------------------------------------------------------------------------------------------------

function checkDocker() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new UsageError('Docker is not available (docker version failed). Start the Docker daemon first.');
  const c = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
  if (c.error || c.status !== 0) throw new UsageError('Docker Compose v2 is not available (docker compose version failed).');
  return { docker: r.stdout.trim(), compose: c.stdout.trim() };
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function checkPorts(settings) {
  const wanted = [
    ['MSCD_HTTP_PORT', settings.httpPort],
    ['MSCD_HTTPS_PORT', settings.httpsPort],
    ['MSCD_KEYCLOAK_PORT', settings.keycloakPort],
    ['MSCD_MAILPIT_PORT', settings.mailpitPort],
  ];
  const seen = new Map();
  for (const [name, port] of wanted) {
    if (seen.has(port)) throw new UsageError(`${name} and ${seen.get(port)} are both ${port}; every published port must differ.`);
    seen.set(port, name);
  }
  const busy = [];
  for (const [name, port] of wanted) if (!(await portFree(port))) busy.push(`${port} (${name})`);
  if (busy.length > 0) {
    throw new UsageError(
      `port ${busy.join(', ')} on 127.0.0.1 is already in use. Stop what listens there, or set ` +
        'MSCD_HTTP_PORT, MSCD_HTTPS_PORT, MSCD_KEYCLOAK_PORT and MSCD_MAILPIT_PORT to free ports.',
    );
  }
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

/** True when two IPv4 CIDR ranges share an address. IPv6 ranges never overlap an IPv4 range. */
function overlaps(a, b) {
  const [ipA, lenA = '32'] = a.split('/');
  const [ipB, lenB = '32'] = b.split('/');
  if (ipA.includes(':') || ipB.includes(':')) return false;
  const size = 2 ** (32 - Math.min(Number(lenA), Number(lenB)));
  return Math.floor(ipv4ToInt(ipA) / size) === Math.floor(ipv4ToInt(ipB) / size);
}

/** Subnets of every Docker network except the ones of our own project (those are removed before the start). */
function dockerSubnets(project) {
  const ids = capture('docker', ['network', 'ls', '-q']).split('\n').filter(Boolean);
  if (ids.length === 0) return [];
  const lines = capture('docker', [
    'network',
    'inspect',
    '--format',
    '{{.Name}}|{{index .Labels "com.docker.compose.project"}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}',
    ...ids,
  ]).split('\n');
  const out = [];
  for (const line of lines) {
    const [name, label, subnets = ''] = line.trim().split('|');
    if (!name || label === project) continue;
    for (const s of subnets.split(/\s+/)) if (/^[0-9.]+\/\d+$/.test(s)) out.push({ name, subnet: s });
  }
  return out;
}

/** The internal network of the stack: MSCD_SUBNET when set, else 172.31.250.0/24 or the first free 172.31.x.0/24. */
function chooseSubnet(env, project) {
  if (env.MSCD_SUBNET) {
    if (!env.MSCD_WEB_ADDRESS) throw new UsageError('MSCD_SUBNET is set without MSCD_WEB_ADDRESS (the fixed web address inside it).');
    return { subnet: env.MSCD_SUBNET, webAddress: env.MSCD_WEB_ADDRESS, chosen: false };
  }
  const used = dockerSubnets(project);
  const candidates = [DEFAULT_SUBNET_OCTET];
  for (let o = 249; o >= 200; o -= 1) candidates.push(o);
  for (const octet of candidates) {
    const subnet = `172.31.${octet}.0/24`;
    if (!used.some((u) => overlaps(u.subnet, subnet))) {
      return { subnet, webAddress: `172.31.${octet}.10`, chosen: octet !== DEFAULT_SUBNET_OCTET };
    }
  }
  throw new UsageError('no free 172.31.x.0/24 range for the internal network; set MSCD_SUBNET and MSCD_WEB_ADDRESS.');
}

// ---- images -----------------------------------------------------------------------------------------------------

function imageRefs(env) {
  const tag = env.MSCD_VERSION;
  return {
    server: `${env.MSCD_SERVER_DEMO_IMAGE || 'cyberlentera/mscd-server-demo'}:${tag}`,
    web: `${env.MSCD_IMAGE || 'cyberlentera/mscd-web'}:${tag}`,
    mock: `${env.MSCD_MOCK_IMAGE || 'cyberlentera/mscd-mock-providers'}:${tag}`,
  };
}

function imageExists(ref) {
  return spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' }).status === 0;
}

async function buildImages(refs, buildCa, outputDir) {
  const builds = [
    ['server', refs.server, ['-f', 'deploy/docker/server.Dockerfile', '--target', 'demo']],
    ['web', refs.web, ['-f', 'deploy/docker/web.Dockerfile', '--build-context', `nginx-config=${path.join(ROOT, 'deploy/nginx')}`]],
    ['mock-providers', refs.mock, ['-f', 'deploy/docker/mock-providers.Dockerfile']],
  ];
  for (const [name, ref, args] of builds) {
    const logFile = path.join(outputDir, `build-${name}.log`);
    writeFileSync(logFile, '');
    const started = Date.now();
    log(`building ${ref} (log: ${path.relative(ROOT, logFile)})`);
    const code = await run(
      'docker',
      ['buildx', 'build', '--load', '--progress=plain', '--secret', `id=build_ca,src=${buildCa}`, ...args, '-t', ref, ROOT],
      { logFile },
    );
    if (code !== 0) {
      process.stderr.write(`${tail(logFile)}\n`);
      throw new Error(`the build of ${ref} failed (exit ${code}); full log in ${logFile}`);
    }
    log(`built ${ref} in ${Math.round((Date.now() - started) / 1000)} s`);
  }
}

// ---- stack ------------------------------------------------------------------------------------------------------

// --env-file /dev/null: Compose would otherwise read deploy/compose/.env (the operator's file of an on-premise
// install, which publishes 0.0.0.0:80 and 443 and sets COMPOSE_PROFILES). The smoke stack takes every setting from
// the variables main() passes.
function composeArgs(project, ...rest) {
  return ['compose', '-p', project, '--env-file', os.devNull, ...COMPOSE_FILES.flatMap((f) => ['-f', f]), ...rest];
}

/** A path given by the user: relative to the folder npm was started in (INIT_CWD), else to the current folder. */
function userPath(p) {
  return path.resolve(process.env.INIT_CWD || process.cwd(), p);
}

async function stackDown(project, env) {
  log(`removing the stack (docker compose -p ${project} down -v)`);
  const code = await run('docker', composeArgs(project, '--profile', 'cli', 'down', '-v', '--remove-orphans', '--timeout', '20'), { env, quiet: true });
  if (code !== 0) process.stderr.write(`smoke: docker compose down -v exited with ${code}; check "docker compose -p ${project} ps -a"\n`);
  return code;
}

async function saveComposeLogs(project, env, outputDir) {
  const file = path.join(outputDir, 'compose.log');
  writeFileSync(file, '');
  await run('docker', composeArgs(project, 'ps', '-a'), { env, logFile: file });
  await run('docker', composeArgs(project, 'logs', '--no-color', '--timestamps'), { env, logFile: file });
  return file;
}

/** Prints the last log lines of every service that is not running and healthy (or a one-shot that failed). */
function showUnhealthy(project, env) {
  let rows = [];
  try {
    rows = capture('docker', composeArgs(project, 'ps', '-a', '--format', '{{.Service}}\t{{.State}}\t{{.Health}}\t{{.ExitCode}}'), env)
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));
  } catch {
    return;
  }
  for (const [service, state, health, exitCode] of rows) {
    const bad = (state === 'running' && health && health !== 'healthy') || (state === 'exited' && exitCode !== '0') || ['dead', 'restarting', 'created'].includes(state);
    if (!bad) continue;
    process.stderr.write(`\n---- ${service}: ${state} ${health || ''} ${state === 'exited' ? `exit ${exitCode}` : ''}\n`);
    const r = spawnSync('docker', composeArgs(project, 'logs', '--no-color', '--tail', '40', service), { env, encoding: 'utf8' });
    process.stderr.write(`${(r.stdout || '') + (r.stderr || '')}\n`);
  }
}

// ---- main -------------------------------------------------------------------------------------------------------

let cleanup = null;
let interrupted = false;

async function main() {
  let options;
  try {
    options = parseCommandLine(process.argv.slice(2));
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const env = { ...process.env };
  // The stack is defined only by the two files and the variables below, not by a .env (composeArgs passes an empty
  // --env-file) or settings of the shell meant for another Compose project.
  for (const name of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES']) delete env[name];
  env.MSCD_VERSION = env.MSCD_VERSION || 'smoke';
  const project = env.SMOKE_PROJECT || 'mscd-smoke';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new UsageError(`SMOKE_PROJECT "${project}" is not a valid Compose project name`);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(env.MSCD_VERSION)) throw new UsageError(`MSCD_VERSION "${env.MSCD_VERSION}" is not a valid image tag`);

  let settings;
  try {
    settings = smokeSettings(env);
  } catch (e) {
    throw new UsageError(e.message);
  }
  // The runner and the browser use these values, so Compose gets them explicitly (also the defaults).
  env.MSCD_HTTP_PORT = String(settings.httpPort);
  env.MSCD_HTTPS_PORT = String(settings.httpsPort);
  env.MSCD_KEYCLOAK_PORT = String(settings.keycloakPort);
  env.MSCD_MAILPIT_PORT = String(settings.mailpitPort);
  env.MSCD_BIND_ADDRESS = '127.0.0.1';
  const versions = checkDocker();
  if (options.down) {
    return (await stackDown(project, env)) === 0 ? 0 : 1;
  }

  const failedVectors = selfTest();
  if (failedVectors.length > 0) throw new Error(`the TOTP helper fails the RFC 6238 vectors at ${failedVectors.join(', ')}`);

  const outputDir = env.SMOKE_OUTPUT_DIR ? userPath(env.SMOKE_OUTPUT_DIR) : path.join(HERE, 'test-results');
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  log(`Docker ${versions.docker}, Compose ${versions.compose}; project ${project}; output in ${outputDir}`);

  // An earlier run that was killed may have left the project behind: start from empty volumes.
  await stackDown(project, env);
  await checkPorts(settings);
  const network = chooseSubnet(env, project);
  env.MSCD_SUBNET = network.subnet;
  env.MSCD_WEB_ADDRESS = network.webAddress;
  if (network.chosen) log(`172.31.${DEFAULT_SUBNET_OCTET}.0/24 is used by another Docker network; the stack uses ${network.subnet}`);

  const refs = imageRefs(env);
  const skipBuild = env.SMOKE_SKIP_BUILD === '1' || env.SMOKE_SKIP_BUILD === 'true';
  if (skipBuild) {
    const missing = Object.values(refs).filter((ref) => !imageExists(ref));
    if (missing.length > 0) {
      throw new UsageError(`SMOKE_SKIP_BUILD is set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing; run once without SMOKE_SKIP_BUILD (or set MSCD_VERSION to the tag you built).`);
    }
    log(`using the existing images ${Object.values(refs).join(', ')}`);
  } else {
    let buildCa = options['build-ca'] ?? env.MSCD_BUILD_CA ?? '';
    let tempCaDir = null;
    if (buildCa === '') {
      // BuildKit refuses /dev/null as a secret source (R-12): an empty file means "no extra CA".
      tempCaDir = mkdtempSync(path.join(os.tmpdir(), 'mscd-smoke-ca-'));
      buildCa = path.join(tempCaDir, 'empty-ca.pem');
      writeFileSync(buildCa, '');
    } else {
      buildCa = userPath(buildCa);
      if (!existsSync(buildCa) || !statSync(buildCa).isFile()) throw new UsageError(`--build-ca ${buildCa} is not a file`);
    }
    try {
      await buildImages(refs, buildCa, outputDir);
    } finally {
      if (tempCaDir) rmSync(tempCaDir, { recursive: true, force: true });
    }
  }

  const keep = options.keep || env.SMOKE_KEEP === '1' || env.SMOKE_KEEP === 'true';
  let stackStarted = false;
  cleanup = async () => {
    if (!stackStarted) return;
    stackStarted = false;
    if (keep) {
      log(`the stack is still running (--keep): ${settings.baseUrl}; remove it with "${project === 'mscd-smoke' ? '' : `SMOKE_PROJECT=${project} `}node tools/smoke/run-smoke.mjs --down"`);
      return;
    }
    await stackDown(project, env);
  };

  let result = 1;
  try {
    stackStarted = true;
    const started = Date.now();
    log(`starting the stack: web ${settings.baseUrl}, Keycloak 127.0.0.1:${settings.keycloakPort}, Mailpit ${settings.mailpitUrl}, network ${network.subnet}`);
    const up = await run('docker', composeArgs(project, 'up', '-d', '--wait', '--wait-timeout', String(UP_TIMEOUT_SECONDS)), { env });
    if (up !== 0) {
      if (interrupted) return 130;
      showUnhealthy(project, env);
      const file = await saveComposeLogs(project, env, outputDir);
      throw new Error(`docker compose up --wait failed (exit ${up}); service logs in ${file}`);
    }
    log(`the stack is healthy after ${Math.round((Date.now() - started) / 1000)} s`);

    const require = createRequire(import.meta.url);
    const cli = require.resolve('@playwright/test/cli');
    const testEnv = { ...env, SMOKE_OUTPUT_DIR: outputDir };
    result = await run(process.execPath, [cli, 'test', '--config', path.join(HERE, 'playwright.config.mjs'), ...options.playwrightArgs], {
      env: testEnv,
      cwd: HERE,
    });
    if (interrupted) return 130;
    if (result !== 0) {
      const file = await saveComposeLogs(project, env, outputDir);
      log(`the smoke tests failed; report in ${path.join(outputDir, 'report')}, service logs in ${file}`);
      result = 1;
    } else {
      log('every smoke check passed');
    }
  } finally {
    await cleanup();
  }
  return result;
}

async function onSignal(signal) {
  interrupted = true;
  process.stderr.write(`\nsmoke: ${signal} received, stopping\n`);
  for (const child of current) child.kill('SIGTERM');
  try {
    if (cleanup) await cleanup();
  } finally {
    process.exit(130);
  }
}
process.once('SIGINT', () => void onSignal('SIGINT'));
process.once('SIGTERM', () => void onSignal('SIGTERM'));

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`smoke: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  },
);
