import type { DoomHubChannelSource, DoomHubSessionScope, DoomHubChannel } from '@agimon-ai/doompi-core/hubChannel';

import {
  presentWorkflowRuns,
  runBelongsToSession,
  runLaunchedBySession,
  type ParsedWorkflowRun,
} from '../../services/workflowRuns';
import { readWorkflowRuns, type ReadWorkflowRunsOptions } from '../../services/workflowWatcher';
import { WORKFLOW_RUNS_TYPE, type WorkflowRunView, type WorkflowRunsPayload } from '../../types/webWorkflows';

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
 *
 * A session sees the runs it owns and, beside them, the runs it handed to its
 * own workflow sessions, so its Activity rows can open each one. Those come
 * from the owners' updates, routed here by the launcher stamp on each run, and
 * from the registry for workflow sessions that are no longer live.
 */
export function createWorkflowsChannel(options: WorkflowsChannelOptions = {}): DoomHubChannel {
  const read = options.read ?? readWorkflowRuns;
  return {
    frameType: WORKFLOW_RUNS_TYPE,
    start(host) {
      const scopes = new Map<string, DoomHubSessionScope>();
      const latest = new Map<string, WorkflowRunsPayload>();
      const subscriptions = new Map<string, () => void>();
      /** Each session's own runs, as it last reported them. */
      const own = new Map<string, readonly WorkflowRunView[]>();
      /** Launcher, then owning workflow session, then the runs one handed the other. */
      const delegated = new Map<string, Map<string, readonly WorkflowRunView[]>>();

      const publish = (sessionId: string): void => {
        if (!scopes.has(sessionId)) return;
        const handed = [...(delegated.get(sessionId)?.values() ?? [])].flat();
        const payload = { runs: presentWorkflowRuns([...(own.get(sessionId) ?? []), ...handed], Date.now()) };
        latest.set(sessionId, payload);
        host.publish(sessionId, payload);
      };

      /** Hands an owner's update to every session that launched one of its runs, or did until now. */
      const routeToLaunchers = (owner: string, runs: readonly WorkflowRunView[]): void => {
        const launchers = new Set<string>();
        for (const run of runs) {
          if (run.launcherSessionId !== undefined && run.launcherSessionId !== owner)
            launchers.add(run.launcherSessionId);
        }
        for (const [launcher, byOwner] of delegated) if (byOwner.has(owner)) launchers.add(launcher);
        for (const launcher of launchers) {
          if (!scopes.has(launcher)) continue;
          const mine = runs.filter((run) => run.launcherSessionId === launcher);
          const byOwner = delegated.get(launcher) ?? new Map<string, readonly WorkflowRunView[]>();
          delegated.set(launcher, byOwner);
          if (mine.length === 0) byOwner.delete(owner);
          else byOwner.set(owner, mine);
          publish(launcher);
        }
      };

      const source: DoomHubChannelSource = {
        payloadFor(scope) {
          return scopes.has(scope.sessionId) ? latest.get(scope.sessionId) : undefined;
        },
        sessionAdded(scope) {
          const sessionId = scope.sessionId;
          scopes.set(sessionId, scope);
          const parsed = read({ environment: scope.environment });
          own.set(
            sessionId,
            parsed.filter((run) => runBelongsToSession(run, sessionId)).map((run) => run.view),
          );
          // Workflow sessions that were released or closed still list their runs here.
          const byOwner = new Map<string, WorkflowRunView[]>();
          for (const run of parsed) {
            if (!runLaunchedBySession(run, sessionId) || run.piSessionId === undefined) continue;
            byOwner.set(run.piSessionId, [...(byOwner.get(run.piSessionId) ?? []), run.view]);
          }
          delegated.set(sessionId, byOwner);
          subscriptions.get(sessionId)?.();
          const unsubscribe = host.directEvents.subscribe(
            WORKFLOW_RUNS_TYPE,
            sessionId,
            (value) => {
              if (!isWorkflowRunsPayload(value)) return;
              own.set(sessionId, value.runs);
              publish(sessionId);
              routeToLaunchers(sessionId, value.runs);
            },
            { replayLatest: true },
          );
          subscriptions.set(sessionId, unsubscribe);
          publish(sessionId);
        },
        sessionRemoved(sessionId) {
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
          scopes.delete(sessionId);
          latest.delete(sessionId);
          own.delete(sessionId);
          // Its slices in its launchers stay: a released workflow session's rows persist there.
          delegated.delete(sessionId);
        },
        close() {
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
          scopes.clear();
          latest.clear();
          own.clear();
          delegated.clear();
        },
      };
      return source;
    },
  };
}
