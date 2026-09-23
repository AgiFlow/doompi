import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  pluginId: 'task',
});
if (!Array.isArray(routed)) throw new Error('Task requires its session web bundle.');
export default defineConfig(routed.map((config) => ({ ...config, exports: false })));
