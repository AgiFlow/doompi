import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const preset = doompiExtension();
const configs = Array.isArray(preset) ? preset : [preset];

export default defineConfig(
  configs.map((config) => {
    if (!('web-client' in config.entry) || config.dts === false) return config;
    return {
      ...config,
      dts: { ...config.dts, tsconfig: 'tsconfig.build.json' },
    };
  }),
);
