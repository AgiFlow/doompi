import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  entry: { cli: 'src/services/designCli/index.ts' },
});
if (!Array.isArray(routed)) throw new Error('style-system requires its web bundle.');

export default defineConfig(routed.map((config) => ({ ...config, exports: false })));
