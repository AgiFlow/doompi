import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/support/vitestEnv.ts'],
    testTimeout: 15_000,
    bail: 10,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/contract/**/*.test.ts'],
    exclude: ['node_modules/**/*', 'dist/**/*', 'coverage/**/*', 'tests/e2e/**/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/services/**', 'src/adapters/**', 'src/web/lib/**', 'src/web/stores/**'],
      exclude: ['node_modules/', 'dist/', 'tests/', '**/*.d.ts', '**/*.config.*', '**/coverage/**'],
      reportOnFailure: false,
      enabled: true,
      skipFull: true,
      cleanOnRerun: true,
      thresholds: { branches: threshold, functions: threshold, lines: threshold, statements: threshold },
    },
  },
});
