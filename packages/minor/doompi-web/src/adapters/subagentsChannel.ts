import type { HubChannelSource, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { SUBAGENT_RUNS_TYPE, type SubagentRun } from '../types/hub.ts';
import { type SubagentRunsSource, watchSubagentRuns } from './subagentWatcher.ts';

/**
 * The built-in subagents data channel: one doom-team runs watcher per managed
 * session, published as { runs } payloads under the 'subagent_runs' frame
 * type. The watcher itself is untouched; this adapter only gives it the
 * generic channel shape every plugin data source uses.
 */
export function createSubagentsChannel(watch: typeof watchSubagentRuns = watchSubagentRuns): WebHubChannel {
  return {
    frameType: SUBAGENT_RUNS_TYPE,
    start(host) {
      const latest = new Map<string, SubagentRun[]>();
      const sources = new Map<string, SubagentRunsSource>();
      const channelSource: HubChannelSource = {
        payloadFor(scope) {
          const runs = latest.get(scope.sessionId);
          return runs === undefined ? undefined : { runs };
        },
        sessionAdded(scope) {
          sources.set(
            scope.sessionId,
            watch(scope.sessionId, (runs) => {
              latest.set(scope.sessionId, runs);
              host.publish(scope.sessionId, { runs });
            }),
          );
        },
        sessionRemoved(sessionId) {
          sources.get(sessionId)?.close();
          sources.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          for (const source of sources.values()) source.close();
          sources.clear();
          latest.clear();
        },
      };
      return channelSource;
    },
  };
}

/** The named export the generated hub registry imports. */
export const webHubChannels: readonly WebHubChannel[] = [createSubagentsChannel()];
