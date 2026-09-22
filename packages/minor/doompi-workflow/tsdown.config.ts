import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  pluginId: 'workflows',
});
if (!Array.isArray(routed)) throw new Error('workflow requires its web bundle.');

export default defineConfig(routed.map((config) => ({ ...config, exports: false })));
