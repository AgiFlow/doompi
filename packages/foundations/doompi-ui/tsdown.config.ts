import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  pluginId: 'builtin-tools',
});
if (!Array.isArray(routed)) throw new Error('UI requires its browser extension bundle.');

export default defineConfig(routed.map((config) => ({ ...config, exports: false })));
