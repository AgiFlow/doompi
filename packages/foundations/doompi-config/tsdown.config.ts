import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

const routed = doompiExtension({
  packageDir: process.cwd(),
  exportsDir: 'src/exports/_none',
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    agentPluginMcp: 'src/exports/agentPluginMcp.ts',
    atomicJson: 'src/exports/atomicJson.ts',
    config: 'src/exports/config.ts',
    configSchema: 'src/exports/configSchema.ts',
    configWriter: 'src/exports/configWriter.ts',
    domains: 'src/exports/domains.ts',
    harnessState: 'src/exports/harnessState.ts',
    harnessStore: 'src/exports/harnessStore.ts',
    index: 'src/exports/index.ts',
    init: 'src/exports/init.ts',
    layeredConfig: 'src/exports/layeredConfig.ts',
    majorModes: 'src/exports/majorModes.ts',
    piConfig: 'src/exports/piConfig.ts',
    piContext: 'src/exports/piContext.ts',
    profiles: 'src/exports/profiles.ts',
    selectionSwitch: 'src/exports/selectionSwitch.ts',
    types: 'src/exports/types.ts',
  },
});
if (Array.isArray(routed)) throw new Error('Config does not provide a browser extension.');

export default defineConfig({ ...routed, exports: false });
