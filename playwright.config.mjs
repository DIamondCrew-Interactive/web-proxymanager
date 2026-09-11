import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  testIgnore: '**/integration/**',
  workers: 2,
  timeout: 30000,
  reporter: [['list'], ['html', { outputFolder: '.build/playwright-report', open: 'never' }]],
  outputDir: '.build/test-results',
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 1536, height: 960 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/serve.mjs', url: 'http://127.0.0.1:4173', reuseExistingServer: false }
});
