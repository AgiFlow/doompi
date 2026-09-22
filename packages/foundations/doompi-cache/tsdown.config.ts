import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  exportsDir: 'src/exports/_none',
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    index: 'src/exports/index.ts',
    env: 'src/exports/env.ts',
  },
});
const configs = Array.isArray(routed) ? routed : [routed];
const packageConfig = configs.find((config) => 'extensions/pi' in config.entry);
if (!packageConfig) throw new Error('Cache requires its generated Pi extension entry.');
const { ['extensions/pi']: piEntry, ...packageEntries } = packageConfig.entry;
if (!piEntry) throw new Error('Cache requires its generated Pi extension entry.');
const contractConfigs = configs.filter((config) => !('extensions/pi' in config.entry));

const output = {
  exports: false,
  format: ['esm', 'cjs'] as ('esm' | 'cjs')[],
  platform: 'node' as const,
  sourcemap: true,
};

export default defineConfig([
  ...contractConfigs.map((config) => ({ ...config, ...output, exports: false })),
  {
    ...packageConfig,
    ...output,
    name: 'package',
    entry: packageEntries,
    unbundle: true,
  },
  {
    ...output,
    name: 'pi-extension',
    entry: { 'extensions/pi': piEntry },
    clean: false,
    dts: { incremental: true, parallel: false, eager: true },
    alias: { '#doompi-cache-optimizer-source': 'pi-cache-optimizer/index.ts' },
    deps: { alwaysBundle: [/^pi-cache-optimizer(?:\/|$)/u] },
    unbundle: false,
  },
]);
