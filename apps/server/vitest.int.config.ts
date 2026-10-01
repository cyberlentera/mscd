import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests of @mscd/server against real PostgreSQL (and, per suite, SeaweedFS, Valkey, Mailpit or
// Keycloak) in containers (build plan J.2). Global setup starts PostgreSQL once per run and builds the
// template databases; every test file then copies a template (test/setup/test-db.ts).
// Testcontainers runs without its reaper container (R-06); the global teardown removes what the run started.
process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';

const workspace = (relative: string) => path.resolve(__dirname, '../..', relative);

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2023',
        keepClassNames: true,
      },
      module: { type: 'es6' },
    }),
  ],
  resolve: {
    alias: [
      { find: /^@mscd\/shared$/, replacement: workspace('packages/shared/src/index.ts') },
      { find: /^@mscd\/pack-tools$/, replacement: workspace('packages/pack-tools/src/index.ts') },
      { find: /^@mscd\/mock-providers$/, replacement: workspace('tools/mock-providers/src/index.ts') },
    ],
  },
  test: {
    include: ['test/int/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 120000,
    teardownTimeout: 60000,
    env: { MSCD__OBSERVABILITY__LOG_LEVEL: 'silent' },
    globalSetup: ['test/setup/global-db.ts', ...(process.env.MSCD_TEST_SSO === '1' ? ['test/setup/keycloak.ts'] : [])],
  },
});
