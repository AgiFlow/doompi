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
        find: '@agimon-ai/doompi-core/pi-extension',
        replacement: source('../../core/doompi-core/src/exports/piExtension.ts'),
      },
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
        find: '@agimon-ai/doompi-core/cordis-host',
        replacement: source('../../core/doompi-core/src/exports/cordisHost.ts'),
      },
      {
        find: '@agimon-ai/doompi-core/ask-user',
        replacement: source('../../core/doompi-core/src/exports/askUser.ts'),
      },
      {
        find: '@agimon-ai/doompi-core/package-api',
        replacement: source('../../core/doompi-core/src/exports/packageApi.ts'),
      },
      {
        find: '@agimon-ai/doompi-core/profile-identity',
        replacement: source('../../core/doompi-core/src/exports/profileIdentity.ts'),
      },
      {
        find: '@agimon-ai/doompi-core/leader',
        replacement: source('../../core/doompi-core/src/exports/leader.ts'),
      },
      {
        find: '@agimon-ai/doompi-voice/voice-tools',
        replacement: source('src/exports/voiceTools.ts'),
      },
      {
        find: '@agimon-ai/doompi-voice/voice-reload-handoff',
        replacement: source('src/exports/voiceReloadHandoff.ts'),
      },
      {
        find: '@agimon-ai/doompi-core/server-facet',
        replacement: source('../../core/doompi-core/src/exports/serverFacet.ts'),
      },
      {
        find: '@agimon-ai/doompi-core/tool-surface',
        replacement: source('../../core/doompi-core/src/exports/toolSurface.ts'),
      },
      {
        find: '@agimon-ai/doompi-core/ui-hub',
        replacement: source('../../core/doompi-core/src/exports/uiHub.ts'),
      },
    ],
  },
});
