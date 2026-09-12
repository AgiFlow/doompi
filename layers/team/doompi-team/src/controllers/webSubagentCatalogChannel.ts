import type {
  DoomHubChannelHost as HubChannelHost,
  DoomHubChannelSource as HubChannelSource,
  DoomHubSessionScope as HubSessionScope,
  DoomHubChannel as WebHubChannel,
} from '@agimon-ai/doompi-core/hub-channel';
import { SUBAGENT_CATALOG_TYPE, type SubagentCatalogPayload } from '../types/webSubagents';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSubagentCatalogPayload(value: unknown): value is SubagentCatalogPayload {
  return (
    isRecord(value) &&
    typeof value.cwd === 'string' &&
    Array.isArray(value.agents) &&
    Array.isArray(value.models) &&
    value.models.every((model) => typeof model === 'string')
  );
}

/**
 * The subagent catalog data channel consumes the session-owned catalog event.
 * The direct event bus retains a bounded latest snapshot for late subscribers.
 */
export function createSubagentCatalogChannel(): WebHubChannel {
  return {
    frameType: SUBAGENT_CATALOG_TYPE,
    start(host: HubChannelHost) {
      const scopes = new Map<string, HubSessionScope>();
      const latest = new Map<string, SubagentCatalogPayload>();
      const subscriptions = new Map<string, () => void>();
      const publish = (scope: HubSessionScope, payload: SubagentCatalogPayload): void => {
        if (scopes.get(scope.sessionId) !== scope || payload.cwd !== scope.cwd) return;
        latest.set(scope.sessionId, payload);
        host.publish(scope.sessionId, payload);
      };
      const source: HubChannelSource = {
        payloadFor(scope) {
          return scopes.has(scope.sessionId) ? latest.get(scope.sessionId) : undefined;
        },
        sessionAdded(scope) {
          subscriptions.get(scope.sessionId)?.();
          scopes.set(scope.sessionId, scope);
          latest.delete(scope.sessionId);
          const unsubscribe = host.directEvents.subscribe(
            SUBAGENT_CATALOG_TYPE,
            scope.sessionId,
            (value) => {
              if (isSubagentCatalogPayload(value)) publish(scope, value);
            },
            { replayLatest: true },
          );
          subscriptions.set(scope.sessionId, unsubscribe);
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
