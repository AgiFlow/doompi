import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { createComputerUseServer } from '../controllers/computerUseServer';
import { createComputerUseChannel } from '../controllers/webComputerUseChannel';
import { api } from '../controllers/computerUseApi';
export const computerUseServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-computer-use',
  global: { channels: [createComputerUseChannel] },
  workspace: { channels: [createComputerUseChannel] },
  session: ({ agent }) => ({ ...(agent ? createComputerUseServer(agent) : {}), api: [api] }),
});
export default computerUseServerFacet;
