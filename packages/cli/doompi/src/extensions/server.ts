import { machineApi } from '@agimon-ai/doompi-core/machineApi';
import { remoteApi } from '@agimon-ai/doompi-core/remoteApi';
import { api } from '@agimon-ai/doompi-core/runtimeContextApi';
import { defineServerPlugin } from '@agimon-ai/doompi-core/serverFacet';
import { sessionFilesApi } from '@agimon-ai/doompi-core/sessionFilesApi';

import { createSetupDiagnosticsTool } from './setupDiagnostics';

export const doompiServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi',
  global: ({ host }) => ({ api: host.context.remoteControl ? [machineApi, remoteApi] : [machineApi] }),
  session: ({ agent, signal: ownerSignal }) => ({
    api: [api, sessionFilesApi],
    tools: agent
      ? [
          createSetupDiagnosticsTool(
            () => agent.context,
            (signal) => {
              ownerSignal.throwIfAborted();
              agent.assertActive('@agimon-ai/doompi');
              if (!(agent.context.selection.state?.['minor-mode'] ?? []).includes('help'))
                throw new Error('Help mode is not active.');
              return signal ? AbortSignal.any([signal, ownerSignal]) : ownerSignal;
            },
          ),
        ]
      : [],
  }),
});

export default doompiServerFacet;
