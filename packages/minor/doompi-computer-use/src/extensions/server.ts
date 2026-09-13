import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { api } from '../controllers/computerUseApi';
import { createComputerUseServer } from '../controllers/computerUseServer';
import { createComputerUseChannel } from '../controllers/webComputerUseChannel';
export const computerUseServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-computer-use',
  global: { channels: [createComputerUseChannel] },
  workspace: { channels: [createComputerUseChannel] },
  session: ({ agent }) => ({ ...(agent ? createComputerUseServer(agent) : {}), api: [api] }),
});
export default computerUseServerFacet;
