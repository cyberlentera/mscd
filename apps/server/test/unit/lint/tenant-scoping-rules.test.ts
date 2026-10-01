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
  const service = (body: string) => `export class S { constructor(private db, private deps) {} f() { ${body} } }`;
  const poolUse = [
    "export async function f(db) { return db.selectFrom('evidence').selectAll().execute(); }",
    service("return this.db.insertInto('x').values({}).execute();"),
    "import { sql } from 'kysely'; export function f(db) { return sql`select 1`.execute(db); }",
    service("return sql`select 1`.execute(this.db);").replace('export class', "import { sql } from 'kysely'; export class"),
    // Builder chains, transactions, connections and other query methods on the pool.
    service("return this.db.withSchema('org_b').selectFrom('evidence').selectAll().execute();"),
    service("return this.db.transaction().execute((trx) => trx.selectFrom('evidence').selectAll().execute());"),
    service("return this.db.connection().execute((c) => c.selectFrom('evidence').selectAll().execute());"),
    service("return this.db.mergeInto('evidence').execute();"),
    service("return this['db'].selectFrom('evidence').selectAll().execute();"),
    "export function f(db) { return db.withSchema('org_b').selectFrom('evidence').selectAll().execute(); }",
    "export function f(db) { return db.schema.createTable('x').execute(); }",
    service("return this.deps.db.selectFrom('evidence').selectAll().execute();"),
    // Aliases and hand-offs of the pool.
    service("const k = this.db; return k.selectFrom('evidence').selectAll().execute();"),
    service("const { db } = this; return db;"),
    service('let k; k = this.db; return k;'),
    'export function f(db) { const k = db; return k; }',
    'export function f(db, g) { return g(db); }',
    'export function f(db, R) { return new R(db); }',
  ];

  it.each(poolUse)('flags direct pool use in a business module: %s', async (code) => {
    expect(await ruleIds('apps/server/src/modules/ui/probe.ts', code)).toContain('no-restricted-syntax');
  });

  it.each(poolUse)('allows it in src/db, src/modules/tenancy and src/seed: %s', async (code) => {
    for (const folder of ['db', 'modules/tenancy', 'seed']) {
      expect(await ruleIds(`apps/server/src/${folder}/probe.ts`, code)).not.toContain('no-restricted-syntax');
    }
  });

  it('allows queries on a transaction', async () => {
    const code = "export function f(trx) { return trx.selectFrom('evidence').selectAll().execute(); }";
    expect(await ruleIds('apps/server/src/modules/ui/probe.ts', code)).toEqual([]);
  });

  it('allows a value named db that is only read', async () => {
    const code = 'export function f(profile) { const db = profile.database; return db.url_file; }';
    expect(await ruleIds('apps/server/src/config/probe.ts', code)).toEqual([]);
  });
});

describe('F.10 platform scope rule', () => {
  const platformUse = [
    'export function f(t) { return t.withPlatform(async () => 1, { scope: "job" }); }',
    'export function f(withPlatform) { return withPlatform(async () => 1, { scope: "job" }); }',
    // Indirect calls, computed members, destructuring, imports and aliases.
    "export function f(t) { return t.withPlatform.call(t, async () => 1, { scope: 'job' }); }",
    "export function f(t) { return t.withPlatform.apply(t, [async () => 1, { scope: 'job' }]); }",
    "export function f(t) { return t['withPlatform'](async () => 1, { scope: 'job' }); }",
    "export function f(t) { return t[`withPlatform`](async () => 1, { scope: 'job' }); }",
    "export function f(t) { const w = t.withPlatform.bind(t); return w(async () => 1, { scope: 'job' }); }",
    "export function f(t) { const w = t.withPlatform; return w(async () => 1, { scope: 'job' }); }",
    "export function f(t) { const { withPlatform } = t; return withPlatform(async () => 1, { scope: 'job' }); }",
    "export function f(t) { const { withPlatform: w } = t; return w(async () => 1, { scope: 'job' }); }",
    "export function f(t) { const { 'withPlatform': w } = t; return w(async () => 1, { scope: 'job' }); }",
    "import { withPlatform as w } from '../tenancy/tenant-scope'; export const f = () => w(async () => 1, { scope: 'job' });",
    'export function f(withPlatform, g) { return g(withPlatform); }',
    'export function f(withPlatform) { const w = withPlatform; return w; }',
  ];

  it.each(platformUse)('flags withPlatform outside the allowed folders: %s', async (code) => {
    for (const folder of ['modules/ui', 'modules/registers', 'db']) {
      expect(await ruleIds(`apps/server/src/${folder}/probe.ts`, code)).toContain('no-restricted-syntax');
    }
  });

  it.each(platformUse)('allows it in identity, ops, jobs, audit, packs, license, tenancy, cli, seed and worker: %s', async (code) => {
    for (const folder of ['modules/identity', 'modules/ops', 'modules/jobs', 'modules/audit', 'modules/packs', 'modules/license', 'modules/tenancy', 'cli', 'seed', 'worker']) {
      expect(await ruleIds(`apps/server/src/${folder}/probe.ts`, code)).toEqual([]);
    }
  });

  it('allows withTenant and a type that only names withPlatform', async () => {
    const code = [
      'export interface Scope { withPlatform(fn: () => Promise<number>): Promise<number> }',
      "export function f(t) { return t.withTenant({ orgId: 'o', schema: 'org_a', userId: 'u', requestId: 'r' }, async () => 1); }",
    ].join('\n');
    expect(await ruleIds('apps/server/src/modules/ui/probe.ts', code)).toEqual([]);
  });
});

describe('F.10 session settings rule', () => {
  it.each([
    "export const q = 'SET search_path = org_a';",
    "export const q = 'set app.org_id to 1';",
    "export const q = 'BEGIN; SET ROLE mscd_app';",
    'export const q = `SET SESSION AUTHORIZATION x`;',
    "export const q = 'SET SCHEMA \\'org_a\\'';",
    "export const q = 'SET SESSION SCHEMA \\'org_a\\'';",
    "export const q = 'set schema \\'org_a\\'';",
    "export const q = 'Set Schema \\'org_a\\'';",
    "export const q = 'SET NAMES \\'utf8\\'';",
    "export const q = 'SET TIME ZONE \\'UTC\\'';",
    "export const q = 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY';",
    "export const q = '/* x */ SET search_path = org_a';",
    "export const q = '-- c\\nSET search_path = org_a';",
    "export const q = 'SET LOCAL a = 1; /* x */ SET b = 2';",
    "export const q = \"SELECT '--'; SET search_path = org_a\";",
    "export const q = 'DO $$ BEGIN SET search_path = org_a; END $$';",
    // PL/pgSQL branches and loops, function bodies and dynamic SQL.
    'export const q = "DO $$ BEGIN IF true THEN SET search_path = org_a; END IF; END $$";',
    'export const q = "DO $$ BEGIN IF false THEN NULL; ELSE SET search_path = org_a; END IF; END $$";',
    'export const q = "DO $$ BEGIN EXECUTE \'SET search_path = org_a\'; END $$";',
    'export const q = "DO $$ BEGIN EXECUTE format(\'SET search_path TO %I\', \'org_a\'); END $$";',
    'export const q = "DO $$ BEGIN LOOP SET search_path = org_a; EXIT; END LOOP; END $$";',
    'export const q = "DO $body$ BEGIN EXECUTE \'set search_path to \' || quote_ident(\'org_a\'); END $body$";',
    'export const q = "DO $$ BEGIN EXECUTE \'set \' || \'search_path = org_a\'; END $$";',
    "export const q = 'CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $f$SET search_path = org_a$f$';",
    "export const q = 'set search_path = org_a; set local role mscd_app';",
    "export const q = 'SET ' + 'search_path = org_a';",
    "export const q = 'set ' + 'search_path = org_a';",
    'export const q = `SET ${"search_path"} TO ${"org_a"}`;',
    "export const q = `select set_config('app.org_id', ${'x'}, false)`;",
    "export const q = \"select set_config('search_path', 'a', false)\";",
    "export const q = \"select set_config('search_path', 'a', 'off')\";",
    "export const q = `select set_config('app.org_id', 'x', ${false})`;",
    "export const q = \"select set_config('app.org_id', 'x')\";",
    "export const q = \"select set_config('app.org_id', \" + 'x';",
  ])('flags %s', async (code) => {
    expect(await ruleIds('apps/server/src/modules/registers/probe.ts', code)).toContain('mscd/no-session-settings');
  });

  it.each([
    "export const q = 'SET LOCAL search_path = org_a';",
    "export const q = 'BEGIN; set local role mscd_app';",
    "export const q = 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE';",
    "export const q = 'SET CONSTRAINTS ALL DEFERRED';",
    "export const q = '-- SET search_path = org_a\\nSET LOCAL search_path = org_a';",
    "export const q = `select set_config('app.org_id', ${'x'}, true)`;",
    "export const q = \"select set_config('app.user_id', 'x', 'on'), set_config('a', lower('B'), TRUE)\";",
    "export const q = 'UPDATE t SET a = 1';",
    "export const q = 'INSERT INTO b VALUES (1) ON CONFLICT (k) DO UPDATE SET hits = b.hits + 1';",
    "export const q = 'DO $$ BEGIN IF true THEN SET LOCAL search_path = org_a; ELSE SET LOCAL role mscd_app; END IF; END $$';",
    "export const q = 'DO $$ BEGIN EXECUTE format(\\'SET LOCAL search_path TO %I\\', \\'org_a\\'); END $$';",
    // The SET option of CREATE FUNCTION after a closing dollar quote or a closing single quote.
    "export const q = 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ SET search_path = pg_catalog LANGUAGE sql';",
    "export const q = 'CREATE FUNCTION f() RETURNS int AS \\'SELECT 1\\' SET search_path = pg_catalog LANGUAGE sql';",
    // English messages: a SET that is not in capitals counts only in a SQL statement shape.
    'export const m = `Set either ${"A"} or ${"A"}_FILE, not both`;',
    "export const m = 'Begin set up of the organisation';",
    "export const m = 'The password is missing; set a new one in the profile';",
    "export const m = 'Reminder not sent; set the owner first';",
    "export const m = 'set up two-factor authentication first';",
    "export const m = 'If no owner is chosen, then set one in the register';",
    "export const m = \"Choose 'set up later' to skip this step\";",
    "export const h = 'set-cookie';",
    "export const r = 'SET';",
  ])('allows %s', async (code) => {
    expect(await ruleIds('apps/server/src/modules/registers/probe.ts', code)).toEqual([]);
  });

  it('allows the withTenant transaction of F.10', async () => {
    const code = [
      "import { sql } from 'kysely';",
      'export class TenantScope {',
      '  constructor(private db) {}',
      '  withTenant(ctx, fn) {',
      '    return this.db.transaction().execute(async (trx) => {',
      "      await sql`select set_config('search_path', ${`\"${ctx.schema}\", ext`}, true),",
      "                       set_config('app.org_id', ${ctx.orgId}, true),",
      "                       set_config('app.user_id', ${ctx.userId}, true),",
      "                       set_config('app.request_id', ${ctx.requestId}, true)`.execute(trx);",
      '      return fn(trx);',
      '    });',
      '  }',
      '}',
    ].join('\n');
    expect(await ruleIds('apps/server/src/modules/tenancy/probe.ts', code)).toEqual([]);
  });
});
