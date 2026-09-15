import { DOOM_DELEGATION_SERVICE, readDoomDelegationService } from '@agimon-ai/doompi-core/delegation';
import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
import type { Context } from '@deepseek-ai/cordis';

import { getDelegationTimeoutMs, getMaxTasks, getStoreTtlMs } from '../../../../services/config';
import { DelegationManager } from '../../../../services/delegation';
import { createNodeDelegationPlatform } from '../../../../services/delegationPlatform';
import { removeLegacyStoreDirectoryAsync, resolveSessionKey, sweepStoreFilesAsync } from '../../../../services/paths';
import { TaskStore } from '../../../../services/taskStore';
import { TASKS_CHANNEL_TYPE } from '../../../../types/webTasks';

const SOURCE = '@agimon-ai/doompi-task';

const root = defineRoot(({ host: serverHost, agent: host }: DoomServerPluginContext) => {
  if (!host) throw new Error('Task session requires the headless host.');
  const execution = host.context;
  if (serverHost.context.directEvents === undefined)
    throw new Error('Task headless facet requires the session direct event bus.');
  const directEvents = serverHost.context.directEvents;
  const maxTasks = getMaxTasks(execution.environment);
  const store = new TaskStore({
    env: execution.environment,
    onCommitted: (_previous, committed) => {
      execution.client.setStatus(SOURCE, `tasks: ${committed.tasks.length}`);
      directEvents.publish(TASKS_CHANNEL_TYPE, execution.sessionId, committed);
    },
  });
  store.configureSession(resolveSessionKey(execution.sessionId, execution.environment));
  const manager = new DelegationManager({
    store,
    cwd: execution.cwd,
    platform: createNodeDelegationPlatform(execution.environment),
    getSessionId: () => execution.sessionId,
    notify: (message) => void execution.client.notify({ body: message.content, level: 'info' }),
    onChange: () => execution.client.setStatus(SOURCE, `tasks: ${store.snapshot.tasks.length}`),
    runTimeoutMs: getDelegationTimeoutMs(execution.environment),
    onNotifyError: (error) => void execution.client.notify({ body: String(error), level: 'warning' }),
  });
  return {
    value: { store, manager, maxTasks },
    services: [
      (serviceContextOwner: Context) => {
        serviceContextOwner.inject([DOOM_DELEGATION_SERVICE], (serviceContext) => {
          const service = readDoomDelegationService(serviceContext);
          if (service) manager.bind(serviceContext, service);
        });
      },
    ],
    activities: [
      {
        name: SOURCE,
        async start(activityContext) {
          store.configureSession(resolveSessionKey(activityContext.sessionId, activityContext.environment));
          await removeLegacyStoreDirectoryAsync(store.storePath, activityContext.cwd);
          if (!activityContext.environment.DOOM_TASK_STORE_PATH)
            await sweepStoreFilesAsync(store.storePath, getStoreTtlMs(activityContext.environment));
          await store.readAsync();
          await manager.reconcile();
          execution.client.setStatus(SOURCE, `tasks: ${store.snapshot.tasks.length}`);
          return () => {
            manager.reset();
            execution.client.setStatus(SOURCE, undefined);
          };
        },
      },
    ],
    onDispose() {
      manager.dispose();
      store.dispose();
    },
  };
});

export type TaskServerScope = ReturnType<typeof root>['value'];
export default root;
