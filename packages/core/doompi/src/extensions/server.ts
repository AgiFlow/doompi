import { machineApi } from '@agimon-ai/doompi-core/machine-api';
import { remoteApi } from '@agimon-ai/doompi-core/remote-api';
import { api } from '@agimon-ai/doompi-core/runtime-context-api';
import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { sessionFilesApi } from '@agimon-ai/doompi-core/session-files-api';

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
