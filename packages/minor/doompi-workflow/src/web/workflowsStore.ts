import type { SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import { defineSessionStore } from '@agimon-ai/doompi-web-contracts';
import { WORKFLOW_RUNS_TYPE, type WorkflowRunView } from '../types/webWorkflows.ts';
import { workflowRunIdentity } from './workflowActivity.ts';

/** One session's record: the hub's last report plus the run this page is looking at. */
export interface WorkflowsSession {
  /** The workflow runs the hub last reported; presented order preserved. */
  runs: WorkflowRunView[];
  /** The run (workspace/runKey) the workflows tab shows; the first run until someone picks. */
  focusedRun: string | undefined;
  /**
   * A launch that was sent and has not shown up yet.
   *
   * The line goes to the session, the run appears on the registry channel some
   * seconds later, and nothing connects the two but timing: the first run this
   * session did not already have is the one that was just asked for.
   */
  pendingLaunch: { workflowPath: string; knownRuns: string[] } | undefined;
}

export const workflows = defineSessionStore<WorkflowsSession>({
  runs: [],
  focusedRun: undefined,
  pendingLaunch: undefined,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Points the workflows tab at one run; the activity dock uses this before opening the tab. */
export function focusRun(sessionId: string, identity: string | undefined): void {
  workflows.update(sessionId, (current) => ({ ...current, focusedRun: identity }));
}

/** Removes a deleted run immediately while the registry channel catches up. */
export function removeRun(sessionId: string, identity: string): void {
  workflows.update(sessionId, (current) => {
    const runs = current.runs.filter((run) => workflowRunIdentity(run) !== identity);
    return {
      ...current,
      runs,
      focusedRun:
        current.focusedRun === identity
          ? runs[0] === undefined
            ? undefined
            : workflowRunIdentity(runs[0])
          : current.focusedRun,
    };
  });
}

/**
 * Sends a launch line to the session and remembers what was already running.
 *
 * The cockpit's only channel to a session is a prompt frame, so a launch is
 * the verb the extension registers for exactly this; see web/launchLine.ts.
 */
export function requestLaunch(send: SessionFrameSender, sessionId: string, line: string, workflowPath: string): void {
  send(sessionId, { type: 'prompt', message: line });
  workflows.update(sessionId, (current) => ({
    ...current,
    pendingLaunch: { workflowPath, knownRuns: current.runs.map(workflowRunIdentity) },
  }));
}

export interface WorkflowRunsPayload {
  runs: WorkflowRunView[];
}

/** The plugin's session data channel: 'workflow_runs' payloads into the store. */
export const workflowRunsChannel = workflows.channel<WorkflowRunsPayload>({
  channel: WORKFLOW_RUNS_TYPE,
  parse(input) {
    if (!isRecord(input) || !Array.isArray(input.runs)) return null;
    return { runs: input.runs.filter(isRecord) as unknown as WorkflowRunView[] };
  },
  reduce: (current, { runs }) => {
    const pending = current.pendingLaunch;
    if (pending === undefined) return { ...current, runs };
    const known = new Set(pending.knownRuns);
    const arrived = runs.find((run) => !known.has(workflowRunIdentity(run)));
    // Until one arrives the launch stays pending: a workflow can take a while
    // to reach the registry, and forgetting it would leave the board wherever
    // the reader last was.
    if (arrived === undefined) return { ...current, runs };
    return { ...current, runs, focusedRun: workflowRunIdentity(arrived), pendingLaunch: undefined };
  },
});
