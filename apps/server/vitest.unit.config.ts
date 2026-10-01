import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Unit tests of @mscd/server: no database, no containers. SWC keeps the decorator metadata Nest needs
// (esbuild drops it); workspace packages are read from source.
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
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20000,
    env: { MSCD__OBSERVABILITY__LOG_LEVEL: 'silent' },
  },
});
