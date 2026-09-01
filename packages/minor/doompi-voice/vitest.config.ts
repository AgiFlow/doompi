import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;
const source = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Native inference and audio pipeline fixtures contend heavily when Vitest
    // multiplies workers inside the already parallel Nx test matrix. Serial
    // files keep the contention bounded, and the raised timeout keeps that
    // contention from being reported as a failure: the heaviest pipeline cases
    // run for about a second on an idle machine and several times that beside
    // the rest of the matrix.
    fileParallelism: false,
    testTimeout: 30_000,
    bail: 10,
    include: ['tests/setup.ts', 'tests/**/*.test.ts'],
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
        find: /^@agimon-ai\/doompi-config\/(.*)$/,
        replacement: `${source('../../core/doompi-config/src/exports/')}$1.ts`,
      },
      { find: '@agimon-ai/doompi-config', replacement: source('../../core/doompi-config/src/exports/index.ts') },
      {
        find: /^@agimon-ai\/doompi-ui\/(.*)$/,
        replacement: `${source('../../core/doompi-ui/src/exports/')}$1.ts`,
      },
      {
        find: '@agimon-ai/doompi-extension-contracts/cordis-host',
        replacement: source('../../core/doompi-extension-contracts/src/exports/cordisHost.ts'),
      },
      {
        find: '@agimon-ai/doompi-extension-contracts/ask-user',
        replacement: source('../../core/doompi-extension-contracts/src/exports/askUser.ts'),
      },
      {
        find: '@agimon-ai/doompi-extension-contracts/package-api',
        replacement: source('../../core/doompi-extension-contracts/src/exports/packageApi.ts'),
      },
      {
        find: '@agimon-ai/doompi-extension-contracts/leader',
        replacement: source('../../core/doompi-extension-contracts/src/exports/leader.ts'),
      },
      {
        find: '@agimon-ai/doompi-extension-contracts/voice-tools',
        replacement: source('../../core/doompi-extension-contracts/src/exports/voiceTools.ts'),
      },
      {
        find: '@agimon-ai/doompi-extension-contracts/voice-reload-handoff',
        replacement: source('../../core/doompi-extension-contracts/src/exports/voiceReloadHandoff.ts'),
      },
      {
        find: '@agimon-ai/doompi-extension-contracts/ui-hub',
        replacement: source('../../core/doompi-extension-contracts/src/exports/uiHub.ts'),
      },
      {
        find: /^@agimon-ai\/doompi-extension-contracts\/(.*)$/,
        replacement: `${source('../../core/doompi-extension-contracts/src/exports/')}$1.ts`,
      },
    ],
  },
});
