// @scaffold-generated
import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;

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
});
