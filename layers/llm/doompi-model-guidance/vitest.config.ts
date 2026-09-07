import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;
const doomConfigExports = fileURLToPath(new URL('../../../packages/core/doompi-config/src/exports/', import.meta.url));
const doomExtensionContractsExports = fileURLToPath(
  new URL('../../../packages/core/doompi-extension-contracts/src/exports/', import.meta.url),
);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    bail: 10,
    exclude: ['node_modules/**/*', 'dist/**/*', 'coverage/**/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      exclude: ['node_modules/', 'dist/', 'tests/', '**/*.d.ts', '**/*.config.*', '**/coverage/**'],
      reportOnFailure: false,
      enabled: true,
      skipFull: true,
      cleanOnRerun: true,
      thresholds: { branches: threshold, functions: threshold, lines: threshold, statements: threshold },
    },
  },
  resolve: {
    alias: [
      {
        find: '@agimon-ai/doompi-extension-contracts/cordis-host',
        replacement: `${doomExtensionContractsExports}cordisHost.ts`,
      },
      {
        find: /^@agimon-ai\/doompi-extension-contracts\/(.*)$/,
        replacement: `${doomExtensionContractsExports}$1.ts`,
      },
      { find: '@agimon-ai/doompi-config/layeredConfig', replacement: `${doomConfigExports}layeredConfig.ts` },
      { find: /^@agimon-ai\/doompi-config\/(.*)$/, replacement: `${doomConfigExports}$1.ts` },
      { find: '@agimon-ai/doompi-config', replacement: `${doomConfigExports}index.ts` },
    ],
  },
});
