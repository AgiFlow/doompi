import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { api } from '../controllers/hubApi';
import { createServerTelemetry } from '../controllers/serverTelemetry';
export const logServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-log',
  global: { api: [api] },
  workspace: { api: [api] },
  session: () => createServerTelemetry(),
});
export default logServerFacet;
