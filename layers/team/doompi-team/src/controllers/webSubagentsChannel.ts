import type {
  DoomHubChannelSource as HubChannelSource,
  DoomHubSessionScope,
  DoomHubChannel as WebHubChannel,
} from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { SUBAGENT_RUNS_TYPE, type SubagentRun } from '../types/webSubagents';

const RUN_ID_PATTERN = /^[\w.-]+$/;

interface SessionRunProjection extends SubagentRun {
  /** Host-private child transcript path. Never published to the browser. */
  sessionFile?: string;
}

type SessionRunProjectionPayload = { runs: SessionRunProjection[] };
type SubagentRunsPayload = { runs: SubagentRun[] };

function isSubagentRunsPayload(value: unknown): value is SessionRunProjectionPayload {
  return typeof value === 'object' && value !== null && Array.isArray((value as { runs?: unknown }).runs);
}

function publicPayload(payload: SessionRunProjectionPayload): SubagentRunsPayload {
  return { runs: payload.runs.map(({ sessionFile: _sessionFile, ...run }) => run) };
}

/**
 * The built-in subagents data channel consumes current state from the
 * host-owned direct event bus. Its bounded latest replay seeds late subscribers.
 */
export function createSubagentsChannel(): WebHubChannel {
  return {
    frameType: SUBAGENT_RUNS_TYPE,
    start(host) {
      const scopes = new Map<string, DoomHubSessionScope>();
      const latest = new Map<string, SessionRunProjectionPayload>();
      const subscriptions = new Map<string, () => void>();
      const publish = (scope: DoomHubSessionScope, payload: SessionRunProjectionPayload): void => {
        if (scopes.get(scope.sessionId) !== scope) return;
        latest.set(scope.sessionId, payload);
        host.publish(scope.sessionId, publicPayload(payload));
      };
      const source: HubChannelSource = {
        payloadFor(scope) {
          const payload = scopes.has(scope.sessionId) ? latest.get(scope.sessionId) : undefined;
          return payload === undefined ? undefined : publicPayload(payload);
        },
        threadJournal(scope, runId) {
          if (!RUN_ID_PATTERN.test(runId)) return undefined;
          const projected = latest.get(scope.sessionId)?.runs.find((run) => run.runId === runId);
          return projected?.sessionFile;
        },
        sessionAdded(scope) {
          subscriptions.get(scope.sessionId)?.();
          scopes.set(scope.sessionId, scope);
          latest.delete(scope.sessionId);
          const unsubscribe = host.directEvents.subscribe(
            SUBAGENT_RUNS_TYPE,
            scope.sessionId,
            (value) => {
              if (isSubagentRunsPayload(value)) publish(scope, value);
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
