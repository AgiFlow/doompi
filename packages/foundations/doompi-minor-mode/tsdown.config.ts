import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({ packageDir: process.cwd() });
export default defineConfig(
  (Array.isArray(routed) ? routed : [routed]).map((config) => ({ ...config, exports: false })),
);
