import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  entry: { voiceWorker: 'src/services/voiceWorker/index.ts' },
});
if (!Array.isArray(routed)) throw new Error('voice requires its web bundle.');

export default defineConfig(
  routed.map((config) =>
    'voiceWorker' in config.entry
      ? { ...config, exports: { exclude: ['voiceWorker'] } }
      : { ...config, exports: false },
  ),
);
