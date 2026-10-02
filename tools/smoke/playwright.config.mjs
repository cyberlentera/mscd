// Playwright configuration of the full-stack smoke test (build plan J.9). run-smoke.mjs starts the Compose stack
// first and passes the ports through the environment (lib/settings.mjs).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { smokeSettings } from './lib/settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const settings = smokeSettings();
const outputDir = path.resolve(process.env.SMOKE_OUTPUT_DIR || path.join(HERE, 'test-results'));

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(outputDir, 'artifacts'),
  // One user journey in order against one stack: no parallel workers and no retries (a retry would meet the
  // records the first attempt already changed).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(outputDir, 'report') }]],
  use: {
    baseURL: settings.baseUrl,
    viewport: { width: 1440, height: 900 },
    locale: 'en-GB',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: { args: [`--host-resolver-rules=${settings.hostResolverRules}`] },
      },
    },
  ],
});
