// Test helpers: repository paths, a small RFC 4180 CSV reader for the pack sources, and readers of the build plan
// tables that the contract must match.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** Parses RFC 4180 CSV with LF line endings into arrays of fields; throws on a stray quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') {
      if (field !== '') throw new Error(`Quote inside an unquoted field at offset ${i}`);
      quoted = true; i += 1; continue;
    }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** CSV text to records keyed by the header row. */
export function csvRecords(text: string): { header: string[]; records: Record<string, string>[] } {
  const [header = [], ...rows] = parseCsv(text);
  return {
    header,
    records: rows.map((r) => {
      if (r.length !== header.length) throw new Error(`Row has ${r.length} fields, header has ${header.length}`);
      return Object.fromEntries(header.map((h, i) => [h, r[i] as string]));
    }),
  };
}

/** The text of the build plan between two headings (start inclusive, end exclusive). */
export function planSection(startHeading: string, endHeading: string): string {
  const md = readRepoFile('docs/platform/BUILD-PLAN.md');
  const start = md.indexOf(startHeading);
  const end = md.indexOf(endHeading, start + 1);
  if (start < 0 || end < 0) throw new Error(`Plan headings not found: ${startHeading} / ${endHeading}`);
  return md.slice(start, end);
}

/** Every `varchar` or `text[]` column CHECK list of the DDL in C.4 to C.6, keyed `table.column`. */
export function planCheckLists(): Map<string, string[]> {
  const part = planSection('### C.4 Platform migrations', '### C.6a');
  const sql = [...part.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  const out = new Map<string, string[]>();
  for (const statement of sql.split(/CREATE TABLE /).slice(1)) {
    const table = (statement.match(/^([\w.]+)/)?.[1] ?? '').replace(/^(platform|ref)\./, '');
    const re = /(\w+)\s+(?:varchar\(\d+\)|text\[\])[^,]*?CHECK\s*\(\s*(?:\1\s+IN\s*\(([^)]*)\)|cardinality\(\1\)\s*>=\s*\d+\s+AND\s+\1\s*<@\s*ARRAY\[([^\]]*)\]|\1\s*<@\s*ARRAY\[([^\]]*)\])/g;
    for (const m of statement.matchAll(re)) {
      const list = (m[2] ?? m[3] ?? m[4] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
      out.set(`${table}.${m[1]}`, list);
    }
  }
  return out;
}

/** Rows of the F.6 permission matrix: permission codes, scope cell and the eleven role cells. */
export function planPermissionRows(): { permissions: string[]; scope: string; cells: string[] }[] {
  const part = planSection('### F.6 Permission matrix', '### F.7');
  const rows: { permissions: string[]; scope: string; cells: string[] }[] = [];
  for (const line of part.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const permissions = [...(cells[0] ?? '').matchAll(/`([a-z_.]+)`/g)].map((m) => m[1] as string);
    rows.push({ permissions, scope: cells[1] ?? '', cells: cells.slice(2) });
  }
  return rows;
}

export interface PlanEndpoint {
  method: string;
  /** Path as written in the plan, without query string (`/ms/{ms}/documents`). */
  path: string;
}

/** Method and path of a table cell such as `POST /a/{id}/approve`, `/reject` (a sibling) or `/{id}` (a child). */
function endpointsOfCell(cell: string, defaultMethod: string | null): PlanEndpoint[] {
  const out: PlanEndpoint[] = [];
  for (const [, code] of cell.matchAll(/`([^`]+)`/g)) {
    const text = (code as string).replace(/\?.*$/, '').trim();
    const full = text.match(/^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/);
    if (full) {
      out.push({ method: full[1] as string, path: full[2] as string });
      continue;
    }
    if (!text.startsWith('/')) continue;
    const previous = out[out.length - 1];
    if (previous) {
      // `/{id}` after a collection is a child; `/reject` after `/approve` is a sibling.
      const parent = text.startsWith('/{') ? previous.path : previous.path.replace(/\/[^/]+$/, '');
      out.push({ method: previous.method, path: `${parent}${text}` });
    } else if (defaultMethod) {
      out.push({ method: defaultMethod, path: text });
    }
  }
  return out;
}

/** Every endpoint of the D.3 tables (paths below `/api/v1`), health and metrics excluded. */
export function planApiEndpoints(): PlanEndpoint[] {
  const part = planSection('### D.3 Endpoints', '**Health and metrics**');
  const out: PlanEndpoint[] = [];
  let defaultMethod: string | null = null;
  for (const line of part.split('\n')) {
    if (line.startsWith('| Path |')) defaultMethod = 'GET';
    else if (line.startsWith('| Method and path |')) defaultMethod = null;
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1] ?? '';
    out.push(...endpointsOfCell(first, defaultMethod));
  }
  return out;
}

/** Every endpoint of the D.5 gateway protocol table. */
export function planGatewayEndpoints(): PlanEndpoint[] {
  const part = planSection('### D.5 Storage gateway protocol', '## E. Worker jobs');
  const out: PlanEndpoint[] = [];
  for (const line of part.split('\n')) {
    if (!line.startsWith('| `')) continue;
    out.push(...endpointsOfCell(line.split('|')[1] ?? '', null).filter((e) => e.path.startsWith('/v1/')));
  }
  return out;
}

/** Route path in Fastify form (`/api/v1/ms/:ms`) of a plan path (`/ms/{ms}`). */
export function fastifyPath(planPath: string, prefix: string): string {
  return `${prefix}${planPath.replace(/\{([A-Za-z]+)\}/g, ':$1')}`;
}

/** The work package ids of section K.2 (`#### WP-nn`). */
export function planWorkPackages(): string[] {
  return [...readRepoFile('docs/platform/BUILD-PLAN.md').matchAll(/^#### (WP-\d\d)\b/gm)].map((m) => m[1] as string);
}
