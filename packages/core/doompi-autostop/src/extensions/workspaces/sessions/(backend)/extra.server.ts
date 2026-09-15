import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createBackgroundWorkGate } from '../../../../services/backgroundWorkGate';
import { createServerIdleShutdown } from '../../../../services/serverIdleShutdown';

export default ({ agent }: DoomServerPluginContext) => {
  if (!agent) return {};
  const backgroundWork = createBackgroundWorkGate();
  const watch = createServerIdleShutdown(agent, () => backgroundWork.hasActiveWork(agent.context.sessionId));
  return {
    services: [backgroundWork.plugin],
    hooks: watch.hooks,
    onDispose: watch.dispose,
  };
};
