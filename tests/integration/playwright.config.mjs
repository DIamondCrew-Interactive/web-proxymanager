import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'live.spec.mjs', workers: 1, retries: 0, timeout: 90000,
  reporter: 'line',
  // No traces, saved auth state, videos or request/response dumps with credentials.
  outputDir: '/tmp/playwright-results',
  use: { baseURL: 'http://127.0.0.1:81', viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'off', video: 'off' }
});
