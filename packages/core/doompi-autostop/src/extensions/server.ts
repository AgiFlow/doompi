import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { createServerIdleShutdown } from '../services/serverIdleShutdown';
export const autoStopServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-autostop',
  session: ({ agent }) => {
    if (!agent) return {};
    const watch = createServerIdleShutdown(agent);
    return { hooks: watch.hooks, onDispose: watch.dispose };
  },
});
export default autoStopServerFacet;
