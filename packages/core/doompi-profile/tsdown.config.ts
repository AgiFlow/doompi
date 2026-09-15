import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  entry: { 'extensions/persona': 'src/extensions/_standalone/persona.ts' },
});

export default defineConfig(routed);
