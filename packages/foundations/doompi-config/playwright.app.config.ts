import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  use: { browserName: 'chromium', headless: true, viewport: { width: 640, height: 640 } },
});
