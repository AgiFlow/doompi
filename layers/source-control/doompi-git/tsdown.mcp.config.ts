import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

export default defineConfig(doompiExtension({ packageDir: '.', pluginId: 'git', target: 'mcp' }));
