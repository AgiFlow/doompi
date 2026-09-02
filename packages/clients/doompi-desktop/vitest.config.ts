import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    bail: 10,
    exclude: ['node_modules/**/*', 'dist/**/*', 'build/**/*', 'release/**/*', 'coverage/**/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      // The Electron entry and the window adapter only run inside a packaged
      // app, so they are verified by launching one rather than by unit tests.
      include: ['src/services/**'],
      exclude: ['node_modules/', 'dist/', 'tests/', '**/*.d.ts', '**/*.config.*', '**/coverage/**'],
      reportOnFailure: false,
      enabled: true,
      skipFull: true,
      cleanOnRerun: true,
      thresholds: { branches: threshold, functions: threshold, lines: threshold, statements: threshold },
    },
  },
});
