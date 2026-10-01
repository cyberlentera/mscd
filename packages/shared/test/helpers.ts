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
