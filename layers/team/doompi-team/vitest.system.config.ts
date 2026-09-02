import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    bail: 10,
    include: ['tests/system/**/*.system.test.ts'],
    exclude: ['node_modules/**/*', 'dist/**/*', 'coverage/**/*'],
    // One file at a time. These suites launch real Pi processes and detached
    // children, so two files at once compete for the same CPU and make a
    // 30-second budget a race rather than a measurement.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: { enabled: false },
  },
});
