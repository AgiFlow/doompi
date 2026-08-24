import { defineSessionStore } from '@agimon-ai/doompi-web-contracts';
import { WORKFLOW_RUNS_TYPE, type WorkflowRunView } from '../src/types/webWorkflows.ts';

/** One session's record: the hub's last report plus the run this page is looking at. */
export interface WorkflowsSession {
  /** The workflow runs the hub last reported; presented order preserved. */
  runs: WorkflowRunView[];
  /** The run (workspace/runKey) the workflows tab shows; the first run until someone picks. */
  focusedRun: string | undefined;
}

export const workflows = defineSessionStore<WorkflowsSession>({ runs: [], focusedRun: undefined });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Points the workflows tab at one run; the activity dock uses this before opening the tab. */
export function focusRun(sessionId: string, identity: string | undefined): void {
  workflows.update(sessionId, (current) => ({ ...current, focusedRun: identity }));
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
  reduce: (current, { runs }) => ({ ...current, runs }),
});
