import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const preset = doompiExtension();
const configs = Array.isArray(preset) ? preset : [preset];

export default defineConfig(
  configs.map((config) => ('web-client' in config.entry ? { ...config, tsconfig: 'tsconfig.web.json' } : config)),
);
