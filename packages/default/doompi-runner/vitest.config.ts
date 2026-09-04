import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;
const doomExtensionContractsExports = fileURLToPath(
  new URL('../../core/doompi-extension-contracts/src/exports/', import.meta.url),
);
const doomUiExports = fileURLToPath(new URL('../../core/doompi-ui/src/exports/', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
        find: '@agimon-ai/doompi-extension-contracts/background-work',
        replacement: `${doomExtensionContractsExports}backgroundWork.ts`,
      },
      {
        find: '@agimon-ai/doompi-extension-contracts/child-process',
        replacement: `${doomExtensionContractsExports}childProcess.ts`,
      },
      {
        find: '@agimon-ai/doompi-extension-contracts/ui-hub',
        replacement: `${doomExtensionContractsExports}uiHub.ts`,
      },
      {
        find: /^@agimon-ai\/doompi-extension-contracts\/(.*)$/,
        replacement: `${doomExtensionContractsExports}$1.ts`,
      },
      { find: /^@agimon-ai\/doompi-ui\/(.*)$/, replacement: `${doomUiExports}$1.ts` },
    ],
  },
});
