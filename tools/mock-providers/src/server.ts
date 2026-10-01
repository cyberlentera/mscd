#!/usr/bin/env node
// CLI: node dist/server.js [--port 4310] [--host 0.0.0.0] [--fixtures <file>|<name>] [--public-url <url>]
//                          [--verbose] [--self-test]
//
// --fixtures takes a JSON file, or a name such as "demo" for fixtures/<name>.json of this package.
// --self-test starts the server (on 127.0.0.1 unless --host is given), runs a token, list and upload round trip
// for Microsoft 365 and Google Drive against it, stops and exits 0 on success or 1 on failure.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startMockProviders } from './app.js';
import { FixtureError } from './fixtures.js';
import { runSelfTest } from './self-test.js';

const USAGE =
  'Usage: mock-providers [--port 4310] [--host 0.0.0.0] [--fixtures <file>|<name>] [--public-url <url>] [--verbose] [--self-test]\n';

function fail(message: string, code = 2): never {
  process.stderr.write(`mock-providers: ${message}\n`);
  process.exit(code);
}

let values: Record<string, string | boolean | undefined>;
try {
  ({ values } = parseArgs({
    options: {
      port: { type: 'string', default: '4310' },
      host: { type: 'string' },
      fixtures: { type: 'string' },
      'public-url': { type: 'string' },
      'self-test': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  }));
} catch (error) {
  process.stderr.write(USAGE);
  fail((error as Error).message);
}

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const port = Number(values.port);
if (!/^\d+$/.test(String(values.port)) || port > 65535) fail(`--port must be an integer from 0 to 65535, got "${String(values.port)}"`);
const publicUrl = values['public-url'] as string | undefined;
if (publicUrl !== undefined && !URL.canParse(publicUrl)) fail(`--public-url must be an absolute URL, got "${publicUrl}"`);
const selfTest = values['self-test'] === true;
const host = (values.host as string | undefined) ?? (selfTest ? '127.0.0.1' : '0.0.0.0');

async function loadFixtures(value: string | undefined): Promise<unknown> {
  if (value === undefined) return undefined;
  const named = !value.includes('/') && !value.includes('\\') && !value.endsWith('.json');
  const file = named ? fileURLToPath(new URL(`../fixtures/${value}.json`, import.meta.url)) : value;
  if (!existsSync(file)) fail(named ? `fixture set "${value}" not found (expected ${file})` : `fixture file ${file} not found`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    return fail(`cannot read fixtures from ${file}: ${(error as Error).message}`);
  }
}

const fixtures = await loadFixtures(values.fixtures as string | undefined);
let running;
try {
  running = await startMockProviders({
    port,
    host,
    fixtures,
    publicUrl,
    onRequestLog: values.verbose ? (line) => process.stdout.write(`${line}\n`) : undefined,
  });
} catch (error) {
  if (error instanceof FixtureError) fail(`invalid fixtures:\n  ${error.problems.join('\n  ')}`);
  fail((error as Error).message);
}

if (selfTest) {
  try {
    await runSelfTest(running.url, (line) => process.stdout.write(`${line}\n`));
    process.stdout.write(`self-test passed against ${running.url}\n`);
    await running.close();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`self-test failed: ${(error as Error).message}\n`);
    await running.close();
    process.exit(1);
  }
}

process.stdout.write(`mock-providers listening on ${host}:${running.port} (${running.url})\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
