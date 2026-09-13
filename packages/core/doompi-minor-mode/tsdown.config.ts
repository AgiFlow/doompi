import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    'extensions/server': 'src/extensions/server.ts',
    index: 'src/exports/index.ts',
    command: 'src/services/command/index.ts',
    catalog: 'src/services/catalog/index.ts',
    projection: 'src/services/projection/index.ts',
    'reload-handoff': 'src/services/reloadHandoff/index.ts',
    'minor-mode-command': 'src/controllers/minorModeCommand.ts',
    mode: 'src/schemas/mode.ts',
    'mode-definition': 'src/services/modeDefinition/index.ts',
    owner: 'src/services/owner/index.ts',
    'extensions/pi': 'src/extensions/pi.ts',
  },
  clean: true,
  dts: { incremental: true, parallel: false, eager: true },
  exports: false,
  format: ['esm', 'cjs'],
  platform: 'node',
  sourcemap: true,
  unbundle: true,
});
