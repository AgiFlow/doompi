import { machineApi } from '@agimon-ai/doompi-core/machineApi';
import { remoteApi } from '@agimon-ai/doompi-core/remoteApi';
import { api } from '@agimon-ai/doompi-core/runtimeContextApi';
import { defineServerPlugin } from '@agimon-ai/doompi-core/serverFacet';
import { sessionFilesApi } from '@agimon-ai/doompi-core/sessionFilesApi';

export const doompiServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi',
  global: ({ host }) => ({
    api: host.context.remoteControl ? [machineApi, remoteApi] : [machineApi],
  }),
  session: {
    api: [api, sessionFilesApi],
  },
});

export default doompiServerFacet;
