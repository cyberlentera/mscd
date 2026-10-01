// Writes dist/openapi.json (OpenAPI 3.1) from the route table of the built package (`npm run openapi` builds
// first). Routes marked testOnly are left out (D.1 "Contract source", J.3).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const { buildOpenApiDocument } = await import(pathToFileURL(path.join(root, 'dist', 'index.js')).href);

const document = buildOpenApiDocument({ version: pkg.version });
const target = path.join(root, 'dist', 'openapi.json');
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);

const paths = Object.keys(document.paths).length;
const operations = Object.values(document.paths).reduce(
  (n, item) => n + Object.keys(item).filter((k) => ['get', 'put', 'post', 'patch', 'delete'].includes(k)).length,
  0,
);
const schemas = Object.keys(document.components.schemas).length;
console.log(`openapi: wrote ${path.relative(process.cwd(), target)} (${paths} paths, ${operations} operations, ${schemas} schemas)`);
