import { DOOM_DELEGATION_SERVICE, readDoomDelegationService } from '@agimon-ai/doompi-core/delegation';
import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
import type { Context } from '@deepseek-ai/cordis';

import { getDelegationTimeoutMs, getMaxTasks, getStoreTtlMs } from '../../../../../services/config';
import { DelegationManager } from '../../../../../services/delegation';
import { createNodeDelegationPlatform } from '../../../../../services/delegationPlatform';
import {
  removeLegacyStoreDirectoryAsync,
  resolveSessionKey,
  sweepStoreFilesAsync,
} from '../../../../../services/paths';
import { TaskStore } from '../../../../../services/taskStore';
import { TASKS_CHANNEL_TYPE } from '../../../../../types/webTasks';

const SOURCE = '@agimon-ai/doompi-task';

/** The notification body: one line, since `client.notify` collapses the rest anyway. */
function headlineOf(content: string): string {
  return content.split('\n').find((line) => line.trim().length > 0) ?? content;
}

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
  let notifications: Promise<void> = Promise.resolve();
  const manager = new DelegationManager({
    store,
    cwd: execution.cwd,
    platform: createNodeDelegationPlatform(execution.environment),
    getSessionId: () => execution.sessionId,
    notify: (message, options) => {
      // `DelegationNotifier` is Pi's `sendMessage` shape, and the Pi facet
      // forwards it verbatim (`root.cli.ts`). A headless session has no such
      // single call, so the three jobs are done by hand:
      //
      //   toast      `client.notify` - operator-facing only, flattened to one
      //              line and capped at 4096 chars, and the model never sees a
      //              custom entry. It gets the headline, not the whole result.
      //   transcript `session.appendCustomEntry` under the same custom type,
      //              carrying the full multi-line content.
      //   wake       `session.admitPrompt(content, 'steer')` - the only call
      //              that puts the completion in front of the model.
      //              `session.prompt(_, 'steer')` is enqueue-only and parks the
      //              message on an idle lane, which is why a finished subagent
      //              used to leave the agent sitting idle.
      //
      // Sequenced so two delegations settling in the same tick each observe
      // settled lane state rather than racing.
      notifications = notifications
        .then(async () => {
          await execution.client.notify({ body: headlineOf(message.content), level: 'info' });
          await execution.session.appendCustomEntry(message.customType, { content: message.content });
          // `triggerTurn: false` has no faithful headless mapping - there is no
          // way to reach model context without starting or joining a turn - so
          // it stays a toast, as it is today. `DelegationManager` always sends
          // `true`, so this is defensive rather than live.
          if (options?.triggerTurn === false) return;
          // Matching the voice facet, which also refuses rather than degrading:
          // `session.prompt(_, 'steer')` is NOT a fallback here, because it is
          // enqueue-only and would park the message on an idle lane - the
          // original bug.
          if (!execution.session.admitPrompt) throw new Error('The session cannot admit a task notification.');
          await execution.session.admitPrompt(message.content, 'steer');
        })
        .catch((error: unknown) => {
          // Mirrors `onNotifyError` below. The delegation is already committed,
          // so a failed notification costs the model its wake-up, not the
          // result, and must not stall later notifications.
          void execution.client.notify({ body: String(error), level: 'warning' });
        });
    },
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

export type TaskServerScope = Awaited<ReturnType<typeof root>>['value'];
export default root;
