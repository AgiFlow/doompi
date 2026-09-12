import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;
const doomExtensionContractsExports = fileURLToPath(
  new URL('../../../packages/core/doompi-core/src/exports/', import.meta.url),
);
const doomUiExports = fileURLToPath(new URL('../../../packages/core/doompi-ui/src/exports/', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup'],
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
        find: '@agimon-ai/doompi-core/runtime-cordis-host',
        replacement: `${doomExtensionContractsExports}../pi/cordisHost.ts`,
      },
      {
        find: '@agimon-ai/doompi-core/pi-extension',
        replacement: `${doomExtensionContractsExports}piExtension.ts`,
      },
      {
        find: '@agimon-ai/doompi-core/cordis-host',
        replacement: `${doomExtensionContractsExports}cordisHost.ts`,
      },
      {
        find: '@agimon-ai/doompi-core/context-contributions',
        replacement: `${doomExtensionContractsExports}contextContributions.ts`,
      },
      {
        find: '@agimon-ai/doompi-core/background-work',
        replacement: `${doomExtensionContractsExports}backgroundWork.ts`,
      },
      {
        find: '@agimon-ai/doompi-core/child-process',
        replacement: `${doomExtensionContractsExports}childProcess.ts`,
      },
      {
        find: '@agimon-ai/doompi-team/subagent-tool',
        replacement: fileURLToPath(new URL('../../team/doompi-team/src/exports/subagentTool.ts', import.meta.url)),
      },
      {
        find: '@agimon-ai/doompi-core/ui-hub',
        replacement: `${doomExtensionContractsExports}uiHub.ts`,
      },
      { find: '@agimon-ai/doompi-ui/doom-overlay', replacement: `${doomUiExports}doomOverlay.ts` },
      { find: /^@agimon-ai\/doompi-ui\/(.*)$/, replacement: `${doomUiExports}$1.ts` },
    ],
  },
});
