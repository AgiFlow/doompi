// @scaffold-generated
import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    env: {
      // Set by a running DoomPi session and inherited by a test run started
      // inside one, where it turns the standalone host fallback the Pi entry
      // contract relies on into a hard failure.
      DOOMPI_CORDIS_HOST_REQUIRED: '',
    },
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
