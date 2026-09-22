import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import { defineMcpTool } from '@agimon-ai/doompi-core/mcpFacet';

import { getDelegationTimeoutMs, getMaxTasks } from '../../../../../services/config';
import { DelegationManager } from '../../../../../services/delegation';
import { createNodeDelegationPlatform } from '../../../../../services/delegationPlatform';
import { resolveSessionKey } from '../../../../../services/paths';
import { TaskStore } from '../../../../../services/taskStore';
import { createHeadlessTaskTool } from '../../../../../services/taskTool';

export default defineMcpTool(({ execution }: DoomMcpPluginContext) => {
  const store = new TaskStore({ cwd: execution.cwd, env: execution.environment });
  store.configureSession(resolveSessionKey(execution.sessionId, execution.environment));
  const manager = new DelegationManager({
    store,
    cwd: execution.cwd,
    platform: createNodeDelegationPlatform(execution.environment),
    getSessionId: () => execution.sessionId,
    runTimeoutMs: getDelegationTimeoutMs(execution.environment),
    onNotifyError: (error) => void execution.client.notify({ body: String(error), level: 'warning' }),
  });
  const tool = createHeadlessTaskTool(store, manager, getMaxTasks(execution.environment));
  let initialized: Promise<void> | undefined;
  return {
    ...tool,
    async execute(...args) {
      initialized ??= store.readAsync().then(async () => {
        await manager.reconcile();
      });
      await initialized;
      return tool.execute(...args);
    },
  };
});
