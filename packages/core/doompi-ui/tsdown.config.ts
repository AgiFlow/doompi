import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  pluginId: 'builtin-tools',
  exportsDir: 'src/exports/_none',
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    leader: 'src/exports/leader.ts',
    extensionName: 'src/exports/extensionName.ts',
    logSinkTelemetry: 'src/exports/logSinkTelemetry.ts',
    toolInventory: 'src/exports/toolInventory.ts',
    footer: 'src/exports/footer.ts',
    toolChrome: 'src/exports/toolChrome.ts',
    uiState: 'src/exports/uiState.ts',
    leaderRegistry: 'src/exports/leaderRegistry.ts',
    harnessMetadata: 'src/exports/harnessMetadata.ts',
    index: 'src/exports/index.ts',
    skills: 'src/exports/skills.ts',
    theme: 'src/exports/theme.ts',
    hashlineRendering: 'src/exports/hashlineRendering.ts',
    rendering: 'src/exports/rendering.ts',
    config: 'src/exports/config.ts',
    'doom-editor': 'src/exports/doomEditor.ts',
    'leader-hints': 'src/exports/leaderHints.ts',
    'matrix-picker': 'src/exports/matrixPicker.ts',
    'doom-footer': 'src/exports/doomFooter.ts',
    'doom-overlay': 'src/exports/doomOverlay.ts',
    'tools-overlay': 'src/exports/toolsOverlay.ts',
    'config-overlay': 'src/exports/configOverlay.ts',
    'doom-header': 'src/exports/doomHeader.ts',
  },
});
if (!Array.isArray(routed)) throw new Error('UI requires its browser extension bundle.');

export default defineConfig([{ ...routed[0], exports: false }, routed[1]]);
