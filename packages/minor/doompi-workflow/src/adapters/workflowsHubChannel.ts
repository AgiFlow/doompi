import type { HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { type ParsedWorkflowRun, presentWorkflowRuns, runBelongsToSession } from '../services/workflowRuns.ts';
import { WORKFLOW_RUNS_TYPE, type WorkflowRunView } from '../types/webWorkflows.ts';
import { watchWorkflowRuns } from './workflowWatcher.ts';

export interface WorkflowsChannelOptions {
  /** Injectable for tests; defaults to watching workflow-mcp's registry. */
  watch?: typeof watchWorkflowRuns;
}

/**
 * The workflows data channel: one hub-wide registry watcher, filtered and
 * presented per session on demand, published as { runs } payloads under the
 * 'workflow_runs' frame type. Live announcements are deduped per session by
 * JSON fingerprint; the subscribe-time snapshot is recomputed so retention
 * keeps moving between registry changes.
 */
export function createWorkflowsChannel(options: WorkflowsChannelOptions = {}): WebHubChannel {
  return {
    frameType: WORKFLOW_RUNS_TYPE,
    start(host) {
      let parsed: ParsedWorkflowRun[] = [];
      const lastPublished = new Map<string, string>();
      const runsFor = (scope: HubSessionScope): WorkflowRunView[] =>
        presentWorkflowRuns(
          parsed
            .filter((run) => runBelongsToSession(run, { sessionId: scope.sessionId, cwd: scope.cwd }))
            .map((run) => run.view),
          Date.now(),
        );
      const watcher = (options.watch ?? watchWorkflowRuns)((runs) => {
        parsed = runs;
        for (const scope of host.sessions()) {
          const view = runsFor(scope);
          const json = JSON.stringify(view);
          if (json === lastPublished.get(scope.sessionId)) continue;
          lastPublished.set(scope.sessionId, json);
          host.publish(scope.sessionId, { runs: view });
        }
      });
      const channelSource: HubChannelSource = {
        payloadFor(scope) {
          return { runs: runsFor(scope) };
        },
        sessionRemoved(sessionId) {
          lastPublished.delete(sessionId);
        },
        close() {
          watcher.close();
        },
      };
      return channelSource;
    },
  };
}

/** The named export the generated hub registry imports. */
export const webHubChannels: readonly WebHubChannel[] = [createWorkflowsChannel()];
