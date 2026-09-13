import type { DoomHubChannelSource, DoomHubSessionScope, DoomHubChannel } from '@agimon-ai/doompi-core/hub-channel';

import {
  createWorkflowCatalogReader,
  presentWorkflowCatalog,
  type WorkflowCatalogReaderDeps,
} from '../services/webWorkflowCatalog';
import { defaultCatalogDeps } from '../services/workflowCatalogDeps';
import { WORKFLOW_CATALOG_TYPE, type WorkflowCatalogPayload } from '../types/webWorkflows';

export interface WorkflowCatalogChannelOptions {
  deps?: WorkflowCatalogReaderDeps;
}

/**
 * The workflow catalog channel. Durable state seeds a session once, then
 * session lifecycle events deliver updates over the direct event bus.
 */
export function createWorkflowCatalogChannel(options: WorkflowCatalogChannelOptions = {}): DoomHubChannel {
  const reader = createWorkflowCatalogReader(options.deps ?? defaultCatalogDeps());
  return {
    frameType: WORKFLOW_CATALOG_TYPE,
    start(host) {
      const scopes = new Map<string, DoomHubSessionScope>();
      const latest = new Map<string, WorkflowCatalogPayload>();
      const subscriptions = new Map<string, () => void>();
      const publish = (scope: DoomHubSessionScope, payload: WorkflowCatalogPayload): void => {
        latest.set(scope.sessionId, payload);
        host.publish(scope.sessionId, payload);
      };
      const readInitial = async (scope: DoomHubSessionScope): Promise<void> => {
        let payload: WorkflowCatalogPayload;
        try {
          payload = {
            cwd: scope.cwd,
            workflows: presentWorkflowCatalog(await reader.read(scope.cwd)),
          };
        } catch (error) {
          const warning = error instanceof Error ? error.message : String(error);
          payload = { cwd: scope.cwd, workflows: [], warning };
          host.onNotice(`workflow catalog for ${scope.cwd} is unavailable (${warning})`);
        }
        if (scopes.get(scope.sessionId) === scope) publish(scope, payload);
      };
      const source: DoomHubChannelSource = {
        payloadFor(scope) {
          return scopes.has(scope.sessionId) ? latest.get(scope.sessionId) : undefined;
        },
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          subscriptions.get(scope.sessionId)?.();
          const unsubscribe = host.directEvents.subscribe(
            WORKFLOW_CATALOG_TYPE,
            scope.sessionId,
            (value) => {
              if (isWorkflowCatalogPayload(value)) publish(scope, value);
            },
            { replayLatest: true },
          );
          subscriptions.set(scope.sessionId, unsubscribe);
          void readInitial(scope);
        },
        sessionRemoved(sessionId) {
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
          scopes.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
          scopes.clear();
          latest.clear();
        },
      };
      return source;
    },
  };
}

function isWorkflowCatalogPayload(value: unknown): value is WorkflowCatalogPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { cwd?: unknown }).cwd === 'string' &&
    Array.isArray((value as { workflows?: unknown }).workflows)
  );
}
