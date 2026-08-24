import { defineSessionChannel, type WebPluginRuntime } from '@agimon-ai/doompi-web-contracts';
import { Store } from '@tanstack/store';
import { SUBAGENT_RUNS_TYPE, type SubagentRun } from '../src/types/webSubagents.ts';

/** The runtime's slash verb that files a stop request for one run. */
const STOP_COMMAND = '/subagents-stop';

const TERMINAL_STATES: ReadonlySet<SubagentRun['state']> = new Set(['done', 'failed', 'stopped']);

export function isTerminalRun(run: SubagentRun): boolean {
  return TERMINAL_STATES.has(run.state);
}

export interface SubagentsState {
  /** The fleet the hub last reported, per session id; presented order preserved. */
  bySession: Record<string, SubagentRun[]>;
  /** Finished runs the reader cleared from the grid; they stay on disk and in the hub's feed. */
  dismissed: Record<string, string[]>;
  /** Runs a stop was asked for and that have not yet reported a final state. */
  stopRequested: Record<string, string[]>;
  /** The run whose drawer the subagents tab shows, per session. */
  openRunId: Record<string, string | undefined>;
}

const initialState: SubagentsState = { bySession: {}, dismissed: {}, stopRequested: {}, openRunId: {} };

export const subagentsStore = new Store<SubagentsState>(initialState);

let runtime: WebPluginRuntime | undefined;

/** Holds the host's sender for the life of the page; the plugin's start hook binds it. */
export function bindSubagentsRuntime(next: WebPluginRuntime): () => void {
  runtime = next;
  return () => {
    if (runtime === next) runtime = undefined;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function without(list: readonly string[] | undefined, runId: string): string[] {
  return (list ?? []).filter((id) => id !== runId);
}

/** The session's runs minus the ones the reader dismissed. */
export function visibleRuns(state: SubagentsState, sessionId: string | null): SubagentRun[] {
  if (sessionId === null) return [];
  const dismissed = state.dismissed[sessionId];
  const runs = state.bySession[sessionId] ?? [];
  return dismissed === undefined || dismissed.length === 0
    ? runs
    : runs.filter((run) => !dismissed.includes(run.runId));
}

export function isStopRequested(state: SubagentsState, sessionId: string, runId: string): boolean {
  return state.stopRequested[sessionId]?.includes(runId) ?? false;
}

/**
 * Asks the runtime to stop a run, through the same slash verb the TUI uses.
 * Pi executes extension commands at once even mid-turn, so this works whether
 * the main agent is idle or blocked on the run. The request is remembered
 * until the run reports a final state; the runtime, not this click, decides
 * when that is.
 */
export function requestRunStop(sessionId: string, runId: string): void {
  runtime?.sendSessionFrame(sessionId, { type: 'prompt', message: `${STOP_COMMAND} ${runId}` });
  subagentsStore.setState((state) => ({
    ...state,
    stopRequested: { ...state.stopRequested, [sessionId]: [...without(state.stopRequested[sessionId], runId), runId] },
  }));
}

/** Hides a finished run from this page; nothing is deleted. */
export function dismissRun(sessionId: string, runId: string): void {
  subagentsStore.setState((state) => ({
    ...state,
    dismissed: { ...state.dismissed, [sessionId]: [...without(state.dismissed[sessionId], runId), runId] },
    openRunId: {
      ...state.openRunId,
      [sessionId]: state.openRunId[sessionId] === runId ? undefined : state.openRunId[sessionId],
    },
  }));
}

export function openRun(sessionId: string, runId: string | undefined): void {
  subagentsStore.setState((state) => ({ ...state, openRunId: { ...state.openRunId, [sessionId]: runId } }));
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
    subagentsStore.setState((state) => {
      const present = new Map(runs.map((run) => [run.runId, run]));
      // A stop request is spent once the run reports a final state or leaves
      // the feed; a dismissal is forgotten once the run is gone from the feed.
      const stopRequested = (state.stopRequested[sessionId] ?? []).filter((runId) => {
        const run = present.get(runId);
        return run !== undefined && !isTerminalRun(run);
      });
      const dismissed = (state.dismissed[sessionId] ?? []).filter((runId) => present.has(runId));
      return {
        ...state,
        bySession: { ...state.bySession, [sessionId]: runs },
        stopRequested: { ...state.stopRequested, [sessionId]: stopRequested },
        dismissed: { ...state.dismissed, [sessionId]: dismissed },
      };
    });
  },
  drop(sessionId) {
    subagentsStore.setState((state) => {
      if (!(sessionId in state.bySession)) return state;
      const bySession = { ...state.bySession };
      const dismissed = { ...state.dismissed };
      const stopRequested = { ...state.stopRequested };
      const openRunId = { ...state.openRunId };
      delete bySession[sessionId];
      delete dismissed[sessionId];
      delete stopRequested[sessionId];
      delete openRunId[sessionId];
      return { bySession, dismissed, stopRequested, openRunId };
    });
  },
});

export function resetSubagents(): void {
  subagentsStore.setState(() => initialState);
}
