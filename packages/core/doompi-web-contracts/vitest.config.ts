import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;

export const vitestConfig = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    bail: 10,
    exclude: ['node_modules/**/*', 'dist/**/*', 'coverage/**/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      exclude: ['node_modules/', 'dist/', 'tests/', 'src/exports/', '**/*.d.ts', '**/*.config.*', '**/coverage/**'],
      reportOnFailure: false,
      enabled: true,
      skipFull: true,
      cleanOnRerun: true,
      thresholds: { branches: threshold, functions: threshold, lines: threshold, statements: threshold },
    },
  },
});

export { vitestConfig as default };
