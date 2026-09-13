import type { DoomHubChannel, DoomHubChannelSource } from '@agimon-ai/doompi-core/hub-channel';

import { RUNNER_RUNS_TYPE } from '../../constants/webRunners';
import { type RunnerRunView } from '../../types/webRunners';

function runnerPayload(value: unknown): value is { runs: RunnerRunView[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { runs?: unknown }).runs);
}

/**
 * The runners data channel consumes lifecycle-owned snapshots from the session
 * server. Durable registry files are read by the owning session only, never by
 * this hub channel.
 */
export function createRunnersChannel(): DoomHubChannel {
  return {
    frameType: RUNNER_RUNS_TYPE,
    start(host) {
      const latest = new Map<string, RunnerRunView[]>();
      const subscriptions = new Map<string, () => void>();
      const source: DoomHubChannelSource = {
        payloadFor(scope) {
          const runs = latest.get(scope.sessionId);
          return runs === undefined ? undefined : { runs };
        },
        sessionAdded(scope) {
          subscriptions.get(scope.sessionId)?.();
          latest.delete(scope.sessionId);
          const unsubscribe = host.directEvents.subscribe(
            RUNNER_RUNS_TYPE,
            scope.sessionId,
            (payload) => {
              if (!runnerPayload(payload)) return;
              latest.set(scope.sessionId, payload.runs);
              host.publish(scope.sessionId, payload);
            },
            { replayLatest: true },
          );
          subscriptions.set(scope.sessionId, unsubscribe);
        },
        sessionRemoved(sessionId) {
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
          latest.clear();
        },
      };
      return source;
    },
  };
}
