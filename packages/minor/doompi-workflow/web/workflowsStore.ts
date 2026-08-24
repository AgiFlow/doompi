import { defineSessionChannel } from '@agimon-ai/doompi-web-contracts';
import { Store } from '@tanstack/store';
import { WORKFLOW_RUNS_TYPE, type WorkflowRunView } from '../src/types/webWorkflows.ts';

export interface WorkflowsState {
  /** The workflow runs the hub last reported, per session id; presented order preserved. */
  bySession: Record<string, WorkflowRunView[]>;
  /** The run (workspace/runKey) the workflows tab shows, per session; the first run until someone picks. */
  focusedRun: Record<string, string | undefined>;
}

const initialState: WorkflowsState = { bySession: {}, focusedRun: {} };

export const workflowsStore = new Store<WorkflowsState>(initialState);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Points the workflows tab at one run; the activity dock uses this before opening the tab. */
export function focusRun(sessionId: string, identity: string | undefined): void {
  workflowsStore.setState((state) => ({ ...state, focusedRun: { ...state.focusedRun, [sessionId]: identity } }));
}

export interface WorkflowRunsPayload {
  runs: WorkflowRunView[];
}

/** The plugin's session data channel: 'workflow_runs' payloads into the store. */
export const workflowRunsChannel = defineSessionChannel<WorkflowRunsPayload>({
  channel: WORKFLOW_RUNS_TYPE,
  parse(input) {
    if (!isRecord(input) || !Array.isArray(input.runs)) return null;
    return { runs: input.runs.filter(isRecord) as unknown as WorkflowRunView[] };
  },
  apply(sessionId, { runs }) {
    workflowsStore.setState((state) => ({ ...state, bySession: { ...state.bySession, [sessionId]: runs } }));
  },
  drop(sessionId) {
    workflowsStore.setState((state) => {
      if (!(sessionId in state.bySession)) return state;
      const bySession = { ...state.bySession };
      const focusedRun = { ...state.focusedRun };
      delete bySession[sessionId];
      delete focusedRun[sessionId];
      return { bySession, focusedRun };
    });
  },
});

export function resetWorkflows(): void {
  workflowsStore.setState(() => initialState);
}
