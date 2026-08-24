import { defineSessionChannel } from '@agimon-ai/doompi-web-contracts';
import { Store } from '@tanstack/store';
import { WORKFLOW_RUNS_TYPE, type WorkflowRunView } from '../src/types/webWorkflows.ts';

export interface WorkflowsState {
  /** The workflow runs the hub last reported, per session id; presented order preserved. */
  bySession: Record<string, WorkflowRunView[]>;
}

const initialState: WorkflowsState = { bySession: {} };

export const workflowsStore = new Store<WorkflowsState>(initialState);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    workflowsStore.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: runs } }));
  },
  drop(sessionId) {
    workflowsStore.setState((state) => {
      if (!(sessionId in state.bySession)) return state;
      const bySession = { ...state.bySession };
      delete bySession[sessionId];
      return { bySession };
    });
  },
});

export function resetWorkflows(): void {
  workflowsStore.setState(() => initialState);
}
