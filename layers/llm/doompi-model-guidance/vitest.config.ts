import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;
const doomConfigExports = fileURLToPath(new URL('../../../packages/core/doompi-config/src/exports/', import.meta.url));
const doomExtensionContractsExports = fileURLToPath(
  new URL('../../../packages/core/doompi-extension-contracts/src/exports/', import.meta.url),
);

/**
 * A home directory with no DoomPi configuration in it.
 *
 * Guidance is read from the global `.doom` scope and then the repository one,
 * so "no guidance file exists" is only true on a machine with an empty home.
 * Anyone running DoomPi has `model-guidance.yaml` in `~/.pi/.doom`, and the
 * suite read theirs instead of the fixture it had just written.
 */
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-model-guidance-home-'));

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
  resolve: {
    alias: [
      {
        find: '@agimon-ai/doompi-extension-contracts/pi-extension',
        replacement: `${doomExtensionContractsExports}piExtension.ts`,
      },
      {
        find: '@agimon-ai/doompi-extension-contracts/cordis-host',
        replacement: `${doomExtensionContractsExports}cordisHost.ts`,
      },
      {
        find: /^@agimon-ai\/doompi-extension-contracts\/(.*)$/,
        replacement: `${doomExtensionContractsExports}$1.ts`,
      },
      { find: '@agimon-ai/doompi-config/layeredConfig', replacement: `${doomConfigExports}layeredConfig.ts` },
      { find: /^@agimon-ai\/doompi-config\/(.*)$/, replacement: `${doomConfigExports}$1.ts` },
      { find: '@agimon-ai/doompi-config', replacement: `${doomConfigExports}index.ts` },
    ],
  },
});
