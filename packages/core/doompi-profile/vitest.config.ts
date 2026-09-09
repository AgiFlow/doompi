// @scaffold-generated
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;

/**
 * A home directory with no DoomPi configuration in it.
 *
 * These suites assert what the global `.doom` scope contributes, so they only
 * pass on a machine that has none. Anyone running DoomPi has `profiles.yaml`
 * in `~/.pi/.doom`, which is every developer and no CI runner: the tests went
 * green in CI and red on the machines that could see the bug.
 */
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-profile-home-'));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    env: {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      // Set by a running DoomPi session and inherited by a test run started
      // inside one, where it turns the standalone host fallback these suites
      // rely on into a hard failure.
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
