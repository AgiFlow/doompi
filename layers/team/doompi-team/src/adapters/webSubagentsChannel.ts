import os from 'node:os';
import path from 'node:path';
import type { HubChannelSource, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { journalPathOf, RUN_ID_PATTERN, RUN_STATUS_FILE_NAME } from '../services/webSubagentRuns.ts';
import { SUBAGENT_RUNS_TYPE, type SubagentRun } from '../types/webSubagents.ts';
import { readAsyncRunStatusAt } from './statusReader.ts';
import { type SubagentRunsSource, teamRunsDirFor, watchSubagentRuns } from './webSubagentWatcher.ts';

/**
 * The built-in subagents data channel: one doom-team runs watcher per managed
 * session, published as { runs } payloads under the 'subagent_runs' frame
 * type. The watcher itself is untouched; this adapter only gives it the
 * generic channel shape every plugin data source uses. A run is also a
 * thread: its status names the child's own Pi session journal, which the
 * hub tails for the cockpit's agent tab.
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
        threadJournal(scope, runId) {
          if (!RUN_ID_PATTERN.test(runId)) return undefined;
          const runsDir = teamRunsDirFor({ sessionId: scope.sessionId, tmpdir: os.tmpdir(), uid: process.getuid?.() });
          if (runsDir === undefined) return undefined;
          const status = readAsyncRunStatusAt(path.join(runsDir, runId, RUN_STATUS_FILE_NAME));
          return status === undefined ? undefined : journalPathOf(status);
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
