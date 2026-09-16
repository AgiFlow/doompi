import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  exportsDir: 'src/exports/_none',
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    index: 'src/exports/index.ts',
    command: 'src/services/command/index.ts',
    catalog: 'src/services/catalog/index.ts',
    projection: 'src/services/projection/index.ts',
    'reload-handoff': 'src/services/reloadHandoff/index.ts',
    'minor-mode-command': 'src/extensions/workspaces/sessions/(backend)/_lib/minorModeCommand.ts',
    mode: 'src/schemas/mode.ts',
    'mode-definition': 'src/services/modeDefinition/index.ts',
    owner: 'src/services/owner/index.ts',
  },
});
if (Array.isArray(routed)) throw new Error('Minor mode does not provide a browser extension.');

export default defineConfig({ ...routed, exports: false });
