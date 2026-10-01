// Unit tests of the web workspace (BUILD-PLAN H.1, J.1): Vitest in the Node environment, the files
// test/**/*.test.{js,ts}. The Playwright suite in e2e/ is not part of it. Vitest matches `include` relative to `dir`,
// and the workspace script runs `vitest run --dir test`, so the pattern below is relative to test/.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    dir: 'test',
    include: ['**/*.test.{js,ts}'],
    environment: 'node',
  },
});
