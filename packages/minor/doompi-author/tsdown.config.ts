import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({ packageDir: process.cwd() });
if (!Array.isArray(routed)) throw new Error('author requires its web bundle.');

export default defineConfig(routed.map((config) => ({ ...config, exports: false })));
