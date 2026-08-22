import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    bail: 10,
    include: ['tests/system/**/*.system.test.ts'],
    exclude: ['node_modules/**/*', 'dist/**/*', 'coverage/**/*'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: { enabled: false },
  },
});
