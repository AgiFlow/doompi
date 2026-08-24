import { defineSessionChannel, type WebPluginRuntime } from '@agimon-ai/doompi-web-contracts';
import { Store } from '@tanstack/store';
import { RUNNER_RUNS_TYPE, type RunnerRunView } from '../src/types/webRunners.ts';

/** The runtime's slash verb that stops one runner headlessly. */
const STOP_COMMAND = '/runners stop';

export interface RunnersState {
  /** The runners the hub last reported, per session id; presented order preserved. */
  bySession: Record<string, RunnerRunView[]>;
  /** Runners a stop was asked for and that have not yet reported an exit. */
  stopRequested: Record<string, string[]>;
}

const initialState: RunnersState = { bySession: {}, stopRequested: {} };

export const runnersStore = new Store<RunnersState>(initialState);

let runtime: WebPluginRuntime | undefined;

/** Holds the host's sender for the life of the page; the plugin's start hook binds it. */
export function bindRunnersRuntime(next: WebPluginRuntime): () => void {
  runtime = next;
  return () => {
    if (runtime === next) runtime = undefined;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sessionRunners(state: RunnersState, sessionId: string | null): RunnerRunView[] {
  return sessionId === null ? [] : (state.bySession[sessionId] ?? []);
}

export function isStopRequested(state: RunnersState, sessionId: string, id: string): boolean {
  return state.stopRequested[sessionId]?.includes(id) ?? false;
}

/**
 * Asks the runtime to stop a runner through the same slash command the TUI's
 * Runner Space uses. The request is remembered until the runner's record
 * reports an exit; the runtime, not this click, decides when that is.
 */
export function requestRunnerStop(sessionId: string, id: string): void {
  runtime?.sendSessionFrame(sessionId, { type: 'prompt', message: `${STOP_COMMAND} ${id}` });
  runnersStore.setState((state) => ({
    ...state,
    stopRequested: {
      ...state.stopRequested,
      [sessionId]: [...(state.stopRequested[sessionId] ?? []).filter((known) => known !== id), id],
    },
  }));
}

export interface RunnerRunsPayload {
  runs: RunnerRunView[];
}

/** The plugin's session data channel: 'runner_runs' payloads into the store. */
export const runnerRunsChannel = defineSessionChannel<RunnerRunsPayload>({
  channel: RUNNER_RUNS_TYPE,
  parse(input) {
    if (!isRecord(input) || !Array.isArray(input.runs)) return null;
    return { runs: input.runs.filter(isRecord) as unknown as RunnerRunView[] };
  },
  apply(sessionId, { runs }) {
    runnersStore.setState((state) => {
      // A stop request is spent once the runner reports an exit or leaves the feed.
      const stillRunning = new Set(runs.filter((run) => run.state === 'running').map((run) => run.id));
      const stopRequested = (state.stopRequested[sessionId] ?? []).filter((id) => stillRunning.has(id));
      return {
        bySession: { ...state.bySession, [sessionId]: runs },
        stopRequested: { ...state.stopRequested, [sessionId]: stopRequested },
      };
    });
  },
  drop(sessionId) {
    runnersStore.setState((state) => {
      if (!(sessionId in state.bySession)) return state;
      const bySession = { ...state.bySession };
      const stopRequested = { ...state.stopRequested };
      delete bySession[sessionId];
      delete stopRequested[sessionId];
      return { bySession, stopRequested };
    });
  },
});

export function resetRunners(): void {
  runnersStore.setState(() => initialState);
}
