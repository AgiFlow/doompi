import { Store } from '@tanstack/store';
import type { WorkflowRunView } from '../../types/hub.ts';

export interface WorkflowsState {
  /** The workflow runs the hub last reported, per session id; presented order preserved. */
  bySession: Record<string, WorkflowRunView[]>;
}

const initialState: WorkflowsState = { bySession: {} };

export const workflowsStore = new Store<WorkflowsState>(initialState);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function applyWorkflowRuns(frame: Record<string, unknown>): void {
  if (typeof frame.sessionId !== 'string' || !Array.isArray(frame.runs)) return;
  const sessionId = frame.sessionId;
  const runs = frame.runs.filter(isRecord) as unknown as WorkflowRunView[];
  workflowsStore.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: runs } }));
}

export function dropWorkflowRuns(sessionId: string): void {
  workflowsStore.setState((state) => {
    if (!(sessionId in state.bySession)) return state;
    const bySession = { ...state.bySession };
    delete bySession[sessionId];
    return { bySession };
  });
}

export function resetWorkflows(): void {
  workflowsStore.setState(() => initialState);
}
