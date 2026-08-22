import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;
const source = (file: string): string => fileURLToPath(new URL(`./src/exports/${file}.ts`, import.meta.url));

export const vitestConfig = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    bail: 10,
    include: [
      'tests/**/*.test.ts',
      '../doompi-ui/tests/extensions/configContribution.test.ts',
      '../doompi-ui/tests/extensions/footerContribution.test.ts',
      '../doompi-ui/tests/extensions/leaderContribution.test.ts',
    ],
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
    alias: {
      '@agimon-ai/doompi-extension-contracts/config': source('config'),
      '@agimon-ai/doompi-extension-contracts/footer': source('footer'),
      '@agimon-ai/doompi-extension-contracts/leader': source('leader'),
      '@agimon-ai/doompi-extension-contracts/mode': source('mode'),
      '@agimon-ai/doompi-extension-contracts/protocol': source('protocol'),
      '@agimon-ai/doompi-extension-contracts/skills': source('skills'),
      '@agimon-ai/doompi-extension-contracts/voice-tools': source('voiceTools'),
    },
  },
});

export default vitestConfig;
