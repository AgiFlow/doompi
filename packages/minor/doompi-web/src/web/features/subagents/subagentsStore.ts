import { defineSessionChannel } from '@agimon-ai/doompi-web-contracts';
import { Store } from '@tanstack/store';
import { SUBAGENT_RUNS_TYPE, type SubagentRun } from '../../../types/hub.ts';

export interface SubagentsState {
  /** The fleet the hub last reported, per session id; presented order preserved. */
  bySession: Record<string, SubagentRun[]>;
}

const initialState: SubagentsState = { bySession: {} };

export const subagentsStore = new Store<SubagentsState>(initialState);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SubagentRunsPayload {
  runs: SubagentRun[];
}

/** The plugin's session data channel: 'subagent_runs' payloads into the store. */
export const subagentRunsChannel = defineSessionChannel<SubagentRunsPayload>({
  channel: SUBAGENT_RUNS_TYPE,
  parse(input) {
    if (!isRecord(input) || !Array.isArray(input.runs)) return null;
    return { runs: input.runs.filter(isRecord) as unknown as SubagentRun[] };
  },
  apply(sessionId, { runs }) {
    subagentsStore.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: runs } }));
  },
  drop(sessionId) {
    subagentsStore.setState((state) => {
      if (!(sessionId in state.bySession)) return state;
      const bySession = { ...state.bySession };
      delete bySession[sessionId];
      return { bySession };
    });
  },
});

export function resetSubagents(): void {
  subagentsStore.setState(() => initialState);
}
