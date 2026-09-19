import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

export default defineConfig(doompiExtension({ packageDir: process.cwd(), target: 'mcp' }));
