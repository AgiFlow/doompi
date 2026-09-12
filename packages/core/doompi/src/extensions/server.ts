import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { api } from '@agimon-ai/doompi-core/runtime-context-api';
import { sessionFilesApi } from '@agimon-ai/doompi-core/session-files-api';
import { machineApi } from '@agimon-ai/doompi-core/machine-api';
import { remoteApi } from '@agimon-ai/doompi-core/remote-api';

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
