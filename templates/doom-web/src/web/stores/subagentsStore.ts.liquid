import { Store } from '@tanstack/store';
import type { SubagentRun } from '../../types/hub.ts';

export interface SubagentsState {
  /** The fleet the hub last reported, per session id; presented order preserved. */
  bySession: Record<string, SubagentRun[]>;
}

const initialState: SubagentsState = { bySession: {} };

export const subagentsStore = new Store<SubagentsState>(initialState);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function applySubagentRuns(frame: Record<string, unknown>): void {
  if (typeof frame.sessionId !== 'string' || !Array.isArray(frame.runs)) return;
  const sessionId = frame.sessionId;
  const runs = frame.runs.filter(isRecord) as unknown as SubagentRun[];
  subagentsStore.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: runs } }));
}

export function dropSubagentRuns(sessionId: string): void {
  subagentsStore.setState((state) => {
    if (!(sessionId in state.bySession)) return state;
    const bySession = { ...state.bySession };
    delete bySession[sessionId];
    return { bySession };
  });
}

export function resetSubagents(): void {
  subagentsStore.setState(() => initialState);
}
