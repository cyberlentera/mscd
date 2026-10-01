import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Workspace packages are read from source during tests, so no build is needed first.
    alias: [{ find: /^@mscd\/shared$/, replacement: path.resolve(here, '../shared/src/index.ts') }],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
