// The F.10 lint restrictions of eslint.config.mjs, checked through the ESLint API on code snippets placed at
// different paths of apps/server/src.
import path from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../../../..');
let eslint: ESLint;

async function ruleIds(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO, file) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
}

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO });
});

describe('F.10 pool rule', () => {
  const poolUse = [
    "export async function f(db) { return db.selectFrom('evidence').selectAll().execute(); }",
    "export class S { constructor(private db) {} f() { return this.db.insertInto('x').values({}).execute(); } }",
    "import { sql } from 'kysely'; export function f(db) { return sql`select 1`.execute(db); }",
    "import { sql } from 'kysely'; export class S { constructor(private db) {} f() { return sql`select 1`.execute(this.db); } }",
  ];

  it.each(poolUse)('flags direct pool queries in a business module: %s', async (code) => {
    expect(await ruleIds('apps/server/src/modules/ui/probe.ts', code)).toContain('no-restricted-syntax');
  });

  it.each(poolUse)('allows them in src/db, src/modules/tenancy and src/seed: %s', async (code) => {
    for (const folder of ['db', 'modules/tenancy', 'seed']) {
      expect(await ruleIds(`apps/server/src/${folder}/probe.ts`, code)).not.toContain('no-restricted-syntax');
    }
  });

  it('allows queries on a transaction', async () => {
    const code = "export function f(trx) { return trx.selectFrom('evidence').selectAll().execute(); }";
    expect(await ruleIds('apps/server/src/modules/ui/probe.ts', code)).toEqual([]);
  });
});

describe('F.10 platform scope rule', () => {
  const code = 'export function f(t) { return t.withPlatform(async () => 1, { scope: "job" }); }';

  it('flags withPlatform outside the allowed folders', async () => {
    for (const folder of ['modules/ui', 'modules/registers', 'db']) {
      expect(await ruleIds(`apps/server/src/${folder}/probe.ts`, code)).toContain('no-restricted-syntax');
    }
  });

  it('allows withPlatform in identity, ops, jobs, audit, packs, license, tenancy, cli, seed and worker', async () => {
    for (const folder of ['modules/identity', 'modules/ops', 'modules/jobs', 'modules/audit', 'modules/packs', 'modules/license', 'modules/tenancy', 'cli', 'seed', 'worker']) {
      expect(await ruleIds(`apps/server/src/${folder}/probe.ts`, code)).toEqual([]);
    }
  });
});

describe('F.10 session settings rule', () => {
  it.each([
    "export const q = 'SET search_path = org_a';",
    "export const q = 'set app.org_id to 1';",
    "export const q = 'BEGIN; SET ROLE mscd_app';",
    'export const q = `SET SESSION AUTHORIZATION x`;',
    "export const q = `select set_config('app.org_id', ${'x'}, false)`;",
    "export const q = \"select set_config('search_path', 'a', false)\";",
  ])('flags %s', async (code) => {
    expect(await ruleIds('apps/server/src/modules/registers/probe.ts', code)).toContain('mscd/no-session-settings');
  });

  it.each([
    "export const q = 'SET LOCAL search_path = org_a';",
    "export const q = `select set_config('app.org_id', ${'x'}, true)`;",
    "export const q = 'UPDATE t SET a = 1';",
    "export const q = 'INSERT INTO b VALUES (1) ON CONFLICT (k) DO UPDATE SET hits = b.hits + 1';",
    'export const m = `Set either ${"A"} or ${"A"}_FILE, not both`;',
  ])('allows %s', async (code) => {
    expect(await ruleIds('apps/server/src/modules/registers/probe.ts', code)).toEqual([]);
  });
});
