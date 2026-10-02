import { defineConfig } from 'vitest/config';

export const runtimeTestConfig = defineConfig({
  test: {
    environment: 'node',
    include: ['tests/system/stagedRuntime.test.ts'],
    coverage: { enabled: false },
    fileParallelism: false,
  },
});

export default runtimeTestConfig;
