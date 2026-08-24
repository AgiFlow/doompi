import type { HubChannelSource, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { RUNNER_RUNS_TYPE, type RunnerRunView } from '../types/webRunners.ts';
import { type RunnerRunsSource, watchRunnerRuns } from './webRunnerWatcher.ts';

/**
 * The runners data channel: one state-directory watcher per managed session,
 * published as { runs } payloads under the 'runner_runs' frame type. The hub
 * runs in its own process, so this reads the records the session's registry
 * writes rather than the registry itself.
 */
export function createRunnersChannel(watch: typeof watchRunnerRuns = watchRunnerRuns): WebHubChannel {
  return {
    frameType: RUNNER_RUNS_TYPE,
    start(host) {
      const latest = new Map<string, RunnerRunView[]>();
      const sources = new Map<string, RunnerRunsSource>();
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
export const webHubChannels: readonly WebHubChannel[] = [createRunnersChannel()];
