// ESLint flat configuration for every workspace (build plan B.1 and the WP-03 brief).
//
// Linted: TypeScript everywhere (`**/*.ts`, `**/*.tsx`) and the plain Node scripts (`*.mjs`) outside the web
// app. The existing web JavaScript (`apps/web/**/*.js`, `*.jsx`, `*.mjs`, the Playwright suite) is not linted in
// this build. The server gets the tenant scoping restrictions of F.10.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SERVER_SRC = 'apps/server/src';

// F.10: the injected pool must not be used outside src/db, src/modules/tenancy and src/seed. Every tenant read
// and write goes through `withTenant`, which hands the callback a transaction `trx`. The pool is `this.db` (the
// injected field) or a binding named `db`. Every reference to `this.db` is flagged, which covers method calls at
// any depth of a builder chain (`this.db.withSchema(...).selectFrom(...)`, `this.db.transaction()`,
// `this.db.connection()`, `this.db.mergeInto(...)`), passing it on (`sql`...`.execute(this.db)`) and aliases
// (`const k = this.db`). A `db` binding is flagged when a method is called on it or on one of its members
// (`db.selectFrom(...)`, `db.schema.createTable(...)`), when it is passed to a call or constructor, or aliased.
const POOL_MESSAGE =
  'Query through withTenant (or withPlatform) and its transaction, not through the injected pool `db` or `this.db` (F.10).';
const POOL_SELECTORS = [
  "MemberExpression[object.type='ThisExpression'][property.name='db']",
  "MemberExpression[object.type='ThisExpression'][computed=true][property.value='db']",
  "VariableDeclarator[init.type='ThisExpression'] > ObjectPattern.id > Property[key.name='db']",
  "AssignmentExpression[right.type='ThisExpression'] > ObjectPattern.left > Property[key.name='db']",
  "CallExpression > MemberExpression.callee[object.type='Identifier'][object.name='db']",
  "CallExpression > MemberExpression.callee > MemberExpression.object[object.type='Identifier'][object.name='db']",
  "CallExpression > MemberExpression.callee > MemberExpression.object[object.type!='ThisExpression'][property.name='db']",
  "CallExpression > Identifier.arguments[name='db']",
  "NewExpression > Identifier.arguments[name='db']",
  "VariableDeclarator > Identifier.init[name='db']",
  "AssignmentExpression > Identifier.right[name='db']",
].map((selector) => ({ selector, message: POOL_MESSAGE }));

// F.10: platform scope (`withPlatform`) only in the folders allowed to cross organisations. Every reference to a
// member `withPlatform` is flagged, not only a direct call, so `x.withPlatform.call(...)`, `.apply(...)`,
// `.bind(...)`, `x['withPlatform'](...)` and aliases (`const w = x.withPlatform`) are covered; so are a call of a
// free function `withPlatform(...)`, importing it, destructuring it (`const { withPlatform } = x`), and passing
// or aliasing the bare name.
const PLATFORM_MESSAGE =
  'withPlatform (platform scope) is allowed only in src/modules/{identity,ops,jobs,audit,packs,license,tenancy}, src/cli, src/seed and src/worker (F.10).';
const PLATFORM_SELECTORS = [
  "CallExpression[callee.type='Identifier'][callee.name='withPlatform']",
  "MemberExpression[computed=false][property.name='withPlatform']",
  "MemberExpression[computed=true][property.value='withPlatform']",
  "MemberExpression[computed=true] > TemplateLiteral.property[expressions.length=0][quasis.0.value.cooked='withPlatform']",
  "ObjectPattern > Property[key.name='withPlatform']",
  "ObjectPattern > Property[key.value='withPlatform']",
  "ImportSpecifier[imported.name='withPlatform']",
  "VariableDeclarator > Identifier.init[name='withPlatform']",
  "AssignmentExpression > Identifier.right[name='withPlatform']",
  "CallExpression > Identifier.arguments[name='withPlatform']",
].map((selector) => ({ selector, message: PLATFORM_MESSAGE }));

// F.10: settings must be transaction local. SQL comments outside quotes are removed first. Then every SET that
// starts a statement and is followed by white space is a session setting, unless the next word is LOCAL,
// TRANSACTION or CONSTRAINTS (transaction scoped). A statement starts at the start of the string, after `;`,
// after the PL/pgSQL words BEGIN, THEN, ELSE and LOOP, after a dollar-quote opener (`$$`, `$tag$`) and after an
// opening single quote (dynamic SQL: `EXECUTE 'SET ...'`, `format('SET ...', ...)`). This covers SET name = v,
// SET name TO v, SET SCHEMA, SET NAMES, SET ROLE, SET SESSION ..., SET TIME ZONE and a bare 'SET ' that is
// concatenated with the rest. `UPDATE t SET`, `DO UPDATE SET`, `ALTER ROLE r SET` and the SET clause of CREATE
// FUNCTION never start a statement.
// SET in capitals always counts. Any other spelling (lower or mixed case, so English such as "Set either A or B"
// or "missing; set a new one") counts only in a statement shape: [SESSION] followed by ROLE, SESSION,
// AUTHORIZATION, SCHEMA, NAMES, SEED, TIME ZONE, XML OPTION, CHARACTERISTICS, or a name followed by `=` or TO;
// or a bare `set ` with nothing after it in the literal (joined to the rest).
const STATEMENT_SET =
  /(?<start>^|;|\b(?:BEGIN|THEN|ELSE|LOOP)\b|\$(?:[A-Za-z_]\w*)?\$|')\s*(?<word>SET)(?=(?<rest>\s[^;]*))/gi;
const TRANSACTION_SCOPED = /^\s+(?:LOCAL|TRANSACTION|CONSTRAINTS)\b/i;
const SESSION_SET_SHAPE =
  /^\s+(?:SESSION\s+)?(?:(?:ROLE|SESSION|AUTHORIZATION|SCHEMA|NAMES|SEED|CHARACTERISTICS)\b|TIME\s+ZONE\b|XML\s+OPTION\b|[A-Za-z_$"][\w.$"]*\s*(?:=|TO\b))/i;
const BARE_SET = /^\s*(?:'|$)/;

/** Replaces `--` and `/* *\/` comments outside quoted literals and identifiers by a space. */
function stripSqlComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      out += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1;
      out += ' ';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
    } else {
      out += c;
    }
  }
  return out;
}

function occurrences(text, token) {
  let count = 0;
  for (let i = text.indexOf(token); i !== -1; i = text.indexOf(token, i + token.length)) count += 1;
  return count;
}

/** True when a quote or dollar-quote `start` at `index` opens a literal (an even number of the same before it). */
function opensLiteral(sqlText, index, start) {
  if (start !== "'" && !start.startsWith('$')) return true;
  return occurrences(sqlText.slice(0, index), start) % 2 === 0;
}

function hasSessionSet(sqlText) {
  for (const match of sqlText.matchAll(STATEMENT_SET)) {
    const { start, word, rest } = match.groups;
    if (!opensLiteral(sqlText, match.index, start)) continue;
    if (TRANSACTION_SCOPED.test(rest)) continue;
    if (word === 'SET' || SESSION_SET_SHAPE.test(rest) || BARE_SET.test(rest)) return true;
  }
  return false;
}

// set_config(name, value, is_local) must pass `true` (or a true literal such as 't' or 'on') as is_local; a call
// with another third argument, a placeholder, or a call that is not closed in the same literal is flagged.
const SET_CONFIG = /\bset_config\s*\(/gi;
const TRUE_LITERAL = /^\(?\s*(?:true|'\s*(?:t|tr|tru|true|y|ye|yes|on|1)\s*')\s*\)?(?:\s*::\s*bool(?:ean)?)?$/i;

function setConfigArguments(sqlText, start) {
  const args = [];
  let depth = 0;
  let quote = null;
  let from = start;
  for (let i = start; i < sqlText.length; i += 1) {
    const c = sqlText[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      if (depth === 0) return [...args, sqlText.slice(from, i)];
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      args.push(sqlText.slice(from, i));
      from = i + 1;
    }
  }
  return null;
}

function hasSessionSetConfig(sqlText) {
  for (const match of sqlText.matchAll(SET_CONFIG)) {
    const args = setConfigArguments(sqlText, match.index + match[0].length);
    if (!args || args.length !== 3 || !TRUE_LITERAL.test(args[2].trim())) return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const noSessionSettings = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow session-level SET statements and set_config(..., false) in SQL strings (F.10)' },
    schema: [],
    messages: {
      sessionSet: 'Use SET LOCAL or set_config(..., true): session-level settings leak into pooled connections (F.10).',
    },
  },
  create(context) {
    const check = (node, text) => {
      const sqlText = stripSqlComments(text);
      if (hasSessionSet(sqlText) || hasSessionSetConfig(sqlText)) {
        context.report({ node, messageId: 'sessionSet' });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateLiteral(node) {
        // Expressions are replaced by a placeholder, so `set_config('a', ${v}, false)` is still seen.
        check(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('$1'));
      },
    };
  },
};

const UNUSED_VARS_OPTIONS = {
  args: 'after-used',
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrors: 'none',
  ignoreRestSiblings: true,
};

export default defineConfig([
  {
    name: 'mscd/ignores',
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/test-results/',
      '**/e2e-report/',
      'packs/sources/',
      'packs/dist/',
      'deploy/dist/',
      'deploy/helm/mscd/ci/.schema-cache/',
      'apps/server/src/generated/',
      'apps/web/**/*.js',
      'apps/web/**/*.jsx',
      'apps/web/**/*.mjs',
      'apps/web/**/*.cjs',
      'project/',
      'chats/',
    ],
  },
  {
    name: 'mscd/typescript',
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', UNUSED_VARS_OPTIONS],
    },
  },
  {
    name: 'mscd/node-scripts',
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', UNUSED_VARS_OPTIONS],
    },
  },
  {
    name: 'mscd/server-tenant-scoping',
    files: [`${SERVER_SRC}/**/*.ts`],
    plugins: { mscd: { rules: { 'no-session-settings': noSessionSettings } } },
    rules: {
      'mscd/no-session-settings': 'error',
      'no-restricted-syntax': ['error', ...POOL_SELECTORS, ...PLATFORM_SELECTORS],
    },
  },
  {
    name: 'mscd/server-pool-allowed',
    files: [`${SERVER_SRC}/db/**/*.ts`],
    rules: {
      'no-restricted-syntax': ['error', ...PLATFORM_SELECTORS],
    },
  },
  {
    name: 'mscd/server-platform-scope-allowed',
    files: [
      `${SERVER_SRC}/modules/{identity,ops,jobs,audit,packs,license}/**/*.ts`,
      `${SERVER_SRC}/cli/**/*.ts`,
      `${SERVER_SRC}/worker/**/*.ts`,
    ],
    rules: {
      'no-restricted-syntax': ['error', ...POOL_SELECTORS],
    },
  },
  {
    name: 'mscd/server-pool-and-platform-scope-allowed',
    files: [`${SERVER_SRC}/modules/tenancy/**/*.ts`, `${SERVER_SRC}/seed/**/*.ts`],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
]);
