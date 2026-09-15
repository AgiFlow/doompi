import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  exportsDir: 'src/exports/_none',
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    index: 'src/exports/index.ts',
    authorFacade: 'src/exports/authorFacade.ts',
  },
});
if (!Array.isArray(routed)) throw new Error('author requires its web bundle.');

export default defineConfig([{ ...routed[0], exports: false }, routed[1]]);
