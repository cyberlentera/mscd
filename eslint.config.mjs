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

// F.10: the injected pool (`db` or `this.db`) must not run queries outside src/db, src/modules/tenancy and
// src/seed. Every tenant read and write goes through `withTenant`, which hands the callback a transaction `trx`.
const POOL_METHODS = 'selectFrom|insertInto|updateTable|deleteFrom|executeQuery|execute';
const POOL_MESSAGE =
  'Query through withTenant (or withPlatform) and its transaction, not through the injected pool (F.10).';
const POOL_SELECTORS = [
  {
    selector: `CallExpression[callee.type='MemberExpression'][callee.property.name=/^(${POOL_METHODS})$/][callee.object.type='Identifier'][callee.object.name='db']`,
    message: POOL_MESSAGE,
  },
  {
    selector: `CallExpression[callee.type='MemberExpression'][callee.property.name=/^(${POOL_METHODS})$/][callee.object.type='MemberExpression'][callee.object.object.type='ThisExpression'][callee.object.property.name='db']`,
    message: POOL_MESSAGE,
  },
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='execute'][arguments.0.type='Identifier'][arguments.0.name='db']",
    message: POOL_MESSAGE,
  },
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='execute'][arguments.0.type='MemberExpression'][arguments.0.object.type='ThisExpression'][arguments.0.property.name='db']",
    message: POOL_MESSAGE,
  },
];

// F.10: platform scope (`withPlatform`) only in the folders allowed to cross organisations.
const PLATFORM_MESSAGE =
  'withPlatform (platform scope) is allowed only in src/modules/{identity,ops,jobs,audit,packs,license,tenancy}, src/cli, src/seed and src/worker (F.10).';
const PLATFORM_SELECTORS = [
  { selector: "CallExpression[callee.type='Identifier'][callee.name='withPlatform']", message: PLATFORM_MESSAGE },
  { selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='withPlatform']", message: PLATFORM_MESSAGE },
];

// F.10: settings must be transaction local. A statement that starts with SET but not SET LOCAL (SET name = v,
// SET name TO v, SET [SESSION] ROLE, SET SESSION AUTHORIZATION, SET TIME ZONE), and set_config(..., false),
// would leak into the pooled connection. The statement shapes keep prose such as "Set either A or B" out.
const SESSION_SET =
  /(^|;)\s*SET\s+(?!LOCAL\b)(?:SESSION\s+)?(?:ROLE\b|AUTHORIZATION\b|TIME\s+ZONE\b|[A-Za-z_][\w."]*\s*(?:=|TO\b))/i;
const SESSION_SET_CONFIG = /\bset_config\s*\((?:[^()]|\([^()]*\))*?,\s*false\s*\)/i;

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
      if (SESSION_SET.test(text) || SESSION_SET_CONFIG.test(text)) {
        context.report({ node, messageId: 'sessionSet' });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateLiteral(node) {
        // Expressions are replaced by a placeholder so `set_config('a', ${v}, false)` is still seen.
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
