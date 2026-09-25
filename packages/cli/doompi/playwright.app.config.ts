import { defineConfig } from '@playwright/test';

export const playwrightAppConfig = defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: { browserName: 'chromium', headless: true, viewport: { width: 640, height: 640 } },
});

export { playwrightAppConfig as default };
