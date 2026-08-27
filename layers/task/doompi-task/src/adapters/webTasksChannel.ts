import type { HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { resolveStorePath } from './store/paths.ts';
import { TaskStore } from './store/taskStore.ts';
import type { TaskDocument } from '../services/store/types.ts';
import { TASKS_CHANNEL_TYPE, type WebTask, type WebTasksPayload } from '../types/webTasks.ts';

interface TaskStoreSource {
  readonly snapshot: TaskDocument;
  read(): TaskDocument;
  onExternalChange(listener: (document: TaskDocument) => void): () => void;
  dispose(): void;
}

export interface TasksChannelOptions {
  /** Injectable for tests. The default opens the session tree's durable task store. */
  storeFor?: (scope: HubSessionScope) => TaskStoreSource;
}

function present(document: TaskDocument): WebTasksPayload {
  const tasks: WebTask[] = document.tasks.flatMap((task) => {
    if (task.status === 'deleted') return [];
    const view: WebTask = {
      id: task.id,
      subject: task.subject,
      status: task.status,
      blockedBy: task.blockedBy ?? [],
    };
    if (task.description) view.description = task.description;
    if (task.activeForm) view.activeForm = task.activeForm;
    if (task.owner) view.owner = task.owner;
    if (task.updatedAt) view.updatedAt = task.updatedAt;
    if (task.delegation) {
      view.delegation = { agent: task.delegation.agent, state: task.delegation.state };
    }
    return [view];
  });
  return { tasks, rev: document.rev };
}

/** Publishes each managed session's durable task graph and follows external subagent writes. */
export function createTasksChannel(options: TasksChannelOptions = {}): WebHubChannel {
  return {
    frameType: TASKS_CHANNEL_TYPE,
    start(host) {
      const stores = new Map<string, { store: TaskStoreSource; unwatch: () => void }>();
      const open = (scope: HubSessionScope): void => {
        if (stores.has(scope.sessionId)) return;
        const store =
          options.storeFor?.(scope) ??
          new TaskStore({ cwd: scope.cwd, storePath: resolveStorePath(scope.cwd, process.env, scope.sessionId) });
        const document = store.read();
        const unwatch = store.onExternalChange((changed) => host.publish(scope.sessionId, present(changed)));
        stores.set(scope.sessionId, { store, unwatch });
        if (document.tasks.length > 0) host.publish(scope.sessionId, present(document));
      };
      const close = (sessionId: string): void => {
        const source = stores.get(sessionId);
        if (!source) return;
        source.unwatch();
        source.store.dispose();
        stores.delete(sessionId);
      };
      for (const scope of host.sessions()) open(scope);

      const source: HubChannelSource = {
        payloadFor(scope) {
          open(scope);
          const document = stores.get(scope.sessionId)?.store.snapshot;
          return document === undefined ? undefined : present(document);
        },
        sessionAdded: open,
        sessionRemoved: close,
        close() {
          for (const sessionId of stores.keys()) close(sessionId);
        },
      };
      return source;
    },
  };
}

/** The named export the generated hub registry imports. */
export const webHubChannels: readonly WebHubChannel[] = [createTasksChannel()];
