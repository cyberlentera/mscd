import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // @api-only specs (e2e/api-only) need the api; the API project runs them (playwright.api.config.js, build plan J.6).
  grepInvert: /@api-only/,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  // Every run builds the app and serves that build. A server already listening on 4173 (for example a
  // `npm run preview` left running) makes the run stop with an error instead of silently testing a stale build.
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
