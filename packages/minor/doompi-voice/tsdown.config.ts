import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  exportsDir: 'src/exports/_none',
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    index: 'src/exports/index.ts',
    clientMedia: 'src/exports/clientMedia.ts',
    voiceReloadHandoff: 'src/exports/voiceReloadHandoff.ts',
    voiceTools: 'src/exports/voiceTools.ts',
    voiceWorker: 'src/services/voiceWorker/index.ts',
  },
});
if (!Array.isArray(routed)) throw new Error('voice requires its web bundle.');

export default defineConfig([{ ...routed[0], exports: false }, routed[1]]);
