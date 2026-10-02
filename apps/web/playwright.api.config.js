import { defineConfig } from '@playwright/test';

// API project (build plan J.6): the specs of e2e/ against a seeded api instead of the sample data. One worker and
// no parallel tests, because every test resets the one database of the stack (e2e-api/fixtures.js). Tests tagged
// @sample-only assert behaviour the api deliberately changes and are skipped here; @api-only specs (e2e/api-only)
// run only here. `node e2e-api/stack.mjs` builds and starts the stack (containers, api, storage gateway, mock
// providers, the web app in API mode on 4174) and stops it, removing its containers, when Playwright sends SIGTERM.
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  grepInvert: /@sample-only/,
  outputDir: 'test-results/api',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report/api' }]],
  use: {
    baseURL: 'http://localhost:4174',
    dataSource: 'api',
    actionTimeout: 15_000,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e-api/stack.mjs',
    url: 'http://localhost:4174/api/v1/system/profile',
    reuseExistingServer: false,
    timeout: 900_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 60_000 },
  },
});
