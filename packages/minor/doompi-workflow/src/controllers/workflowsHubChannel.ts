import type {
  DoomHubChannelSource,
  DoomHubSessionScope,
  DoomHubChannel,
} from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { presentWorkflowRuns, runBelongsToSession, type ParsedWorkflowRun } from '../services/workflowRuns';
import { readWorkflowRuns, type ReadWorkflowRunsOptions } from '../services/workflowWatcher';
import { WORKFLOW_RUNS_TYPE, type WorkflowRunView, type WorkflowRunsPayload } from '../types/webWorkflows';

export interface WorkflowsChannelOptions {
  /** Injectable durable initial snapshot reader for tests. */
  read?: (options: ReadWorkflowRunsOptions) => ParsedWorkflowRun[];
}

function isWorkflowRunsPayload(value: unknown): value is WorkflowRunsPayload {
  return typeof value === 'object' && value !== null && Array.isArray((value as { runs?: unknown }).runs);
}

/**
 * The workflow runs data channel. Durable registry state seeds each session
 * once; subsequent updates arrive through the host-owned direct event bus.
 */
export function createWorkflowsChannel(options: WorkflowsChannelOptions = {}): DoomHubChannel {
  const read = options.read ?? readWorkflowRuns;
  return {
    frameType: WORKFLOW_RUNS_TYPE,
    start(host) {
      const scopes = new Map<string, DoomHubSessionScope>();
      const latest = new Map<string, WorkflowRunsPayload>();
      const subscriptions = new Map<string, () => void>();
      const runsFor = (scope: DoomHubSessionScope, parsed: readonly ParsedWorkflowRun[]): WorkflowRunView[] =>
        presentWorkflowRuns(
          parsed.filter((run) => runBelongsToSession(run, scope.sessionId)).map((run) => run.view),
          Date.now(),
        );
      const publish = (scope: DoomHubSessionScope, payload: WorkflowRunsPayload): void => {
        latest.set(scope.sessionId, payload);
        host.publish(scope.sessionId, payload);
      };
      const source: DoomHubChannelSource = {
        payloadFor(scope) {
          return scopes.has(scope.sessionId) ? latest.get(scope.sessionId) : undefined;
        },
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          subscriptions.get(scope.sessionId)?.();
          const unsubscribe = host.directEvents.subscribe(
            WORKFLOW_RUNS_TYPE,
            scope.sessionId,
            (value) => {
              if (isWorkflowRunsPayload(value)) publish(scope, value);
            },
            { replayLatest: true },
          );
          subscriptions.set(scope.sessionId, unsubscribe);
          const payload = { runs: runsFor(scope, read({ environment: scope.environment })) };
          publish(scope, payload);
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
