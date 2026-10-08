import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import { defineMcpTool } from '@agimon-ai/doompi-core/mcpFacet';

import { RemoteTaskParamsSchema } from '../../../../../schemas/task';
import { getMaxTasks } from '../../../../../services/config';
import { resolveSessionKey } from '../../../../../services/paths';
import { TaskStore } from '../../../../../services/taskStore';
import { createHeadlessTaskTool } from '../../../../../services/taskTool';

export default defineMcpTool(({ execution }: DoomMcpPluginContext) => {
  const store = new TaskStore({ cwd: execution.cwd, env: execution.environment });
  store.configureSession(resolveSessionKey(execution.sessionId, execution.environment));
  // No DelegationManager: remote agents track tasks but never start background agents.
  const tool = createHeadlessTaskTool(store, undefined, getMaxTasks(execution.environment));
  let initialized: Promise<void> | undefined;
  return {
    ...tool,
    parameters: RemoteTaskParamsSchema,
    description:
      'Track multi-step work in the DoomPi session as a persistent task list (todo, plan, task graph). Delegating to background agents is not available here.',
    async execute(...args) {
      initialized ??= store.readAsync().then(() => undefined);
      await initialized;
      return tool.execute(...args);
    },
  };
});
