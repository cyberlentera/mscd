#!/usr/bin/env node
// CLI: node dist/server.js --port 4310 [--host 0.0.0.0] [--fixtures <file>] [--self-test]
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { startMockProviders } from './index.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4310' },
    host: { type: 'string', default: '0.0.0.0' },
    fixtures: { type: 'string' },
    'self-test': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write('Usage: mock-providers [--port 4310] [--host 0.0.0.0] [--fixtures <file>] [--self-test]\n');
  process.exit(0);
}

if (values['self-test']) {
  process.stderr.write('mock-providers --self-test: not implemented in this build yet (WP-10)\n');
  process.exit(2);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`mock-providers: --port must be an integer from 0 to 65535, got "${values.port}"\n`);
  process.exit(2);
}

const fixtures = values.fixtures ? JSON.parse(await readFile(values.fixtures, 'utf8')) : undefined;
const running = await startMockProviders({ port, host: values.host, fixtures });
process.stdout.write(`mock-providers listening on ${running.url}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
