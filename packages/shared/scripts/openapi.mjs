// Writes dist/openapi.json (OpenAPI 3.1). Placeholder from WP-03: the document has no paths yet.
// WP-05 replaces this script with the generator that reads the route table (`z.toJSONSchema`, testOnly
// routes skipped).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const document = {
  openapi: '3.1.0',
  info: { title: 'MSCD API', version: pkg.version },
  servers: [{ url: '/' }],
  paths: {},
};

await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist', 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
console.log(`openapi: wrote ${path.relative(process.cwd(), path.join(root, 'dist', 'openapi.json'))} (0 paths)`);
