import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createBackgroundWorkGate } from '../../../../services/backgroundWorkGate';
import { createServerIdleShutdown } from '../../../../services/serverIdleShutdown';
export default defineRoot(({ agent }: DoomServerPluginContext) => {
  if (!agent) throw new Error('Autostop requires a session host.');
  const backgroundWork = createBackgroundWorkGate();
  const watch = createServerIdleShutdown(agent, () => backgroundWork.hasActiveWork(agent.context.sessionId));
  return { value: watch, services: [backgroundWork.plugin], onDispose: watch.dispose };
});
