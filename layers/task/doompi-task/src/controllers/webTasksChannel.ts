import type { DoomHubChannelSource, DoomHubSessionScope, DoomHubChannel } from '@agimon-ai/doompi-core/hub-channel';
import { resolveStorePath } from '../services/paths';
import { TaskStore } from '../services/taskStore';
import type { TaskDocument } from '../models/task';
import { TASKS_CHANNEL_TYPE, type WebTask, type WebTasksPayload } from '../types/webTasks';

interface TaskStoreSource {
  readonly snapshot: TaskDocument;
  read(): TaskDocument;
  dispose(): void;
}

function isTaskDocument(value: unknown): value is TaskDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TaskDocument).rev === 'number' &&
    Array.isArray((value as TaskDocument).tasks)
  );
}

export interface TasksChannelOptions {
  /** Injectable for tests. The default opens the session tree's durable task store. */
  storeFor?: (scope: DoomHubSessionScope) => TaskStoreSource;
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

/** Publishes each managed session's durable task graph and follows direct session commits. */
export function createTasksChannel(options: TasksChannelOptions = {}): DoomHubChannel {
  return {
    frameType: TASKS_CHANNEL_TYPE,
    start(host) {
      const stores = new Map<string, { store: TaskStoreSource; unsubscribe: () => void; latest?: TaskDocument }>();
      const open = (scope: DoomHubSessionScope): void => {
        if (stores.has(scope.sessionId)) return;
        let store = options.storeFor?.(scope);
        if (store === undefined) {
          if (scope.environment === undefined)
            throw new Error(`Task channel requires an admitted environment for session '${scope.sessionId}'.`);
          store = new TaskStore({
            cwd: scope.cwd,
            env: scope.environment,
            storePath: resolveStorePath(scope.cwd, scope.environment, scope.sessionId),
          });
        }
        store.read();
        const source = { store, unsubscribe: () => undefined as void };
        stores.set(scope.sessionId, source);
        source.unsubscribe = host.directEvents.subscribe(
          TASKS_CHANNEL_TYPE,
          scope.sessionId,
          (payload) => {
            if (!isTaskDocument(payload)) return;
            const current = stores.get(scope.sessionId);
            if (current === undefined) return;
            current.latest = payload;
            host.publish(scope.sessionId, present(payload));
          },
          { replayLatest: true },
        );
      };
      const close = (sessionId: string): void => {
        const source = stores.get(sessionId);
        if (!source) return;
        source.unsubscribe();
        source.store.dispose();
        stores.delete(sessionId);
      };
      for (const scope of host.sessions()) open(scope);

      const source: DoomHubChannelSource = {
        payloadFor(scope) {
          open(scope);
          const source = stores.get(scope.sessionId);
          const document = source?.latest ?? source?.store.snapshot;
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
