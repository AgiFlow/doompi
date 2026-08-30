import { defineSessionStore, type SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import { RUNNER_RUNS_TYPE, type RunnerRunView } from '../src/types/webRunners.ts';

/** The runtime's slash verb that stops one runner headlessly. */
const STOP_COMMAND = '/runners stop';

/** One session's record: the hub's last report plus what this page asked for. */
export interface RunnersSession {
  /** The runners the hub last reported; presented order preserved. */
  runs: RunnerRunView[];
  /** Runners a stop was asked for and that have not yet reported an exit. */
  stopRequested: string[];
}

export const runners = defineSessionStore<RunnersSession>({ runs: [], stopRequested: [] });

/** The runner channel keeps the dock's busy state aligned with its rendered run list. */
export const runnerActivitySource = {
  subscribe(listener: () => void) {
    const subscription = runners.store.subscribe(listener);
    return () => subscription.unsubscribe();
  },
  isActive(sessionId: string | null) {
    return runners.select(runners.store.state, sessionId).runs.some((run) => run.state === 'running');
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Asks the runtime to stop a runner through the same slash command the TUI's
 * Runner Space uses. The request is remembered until the runner's record
 * reports an exit; the runtime, not this click, decides when that is.
 */
export function requestRunnerStop(send: SessionFrameSender, sessionId: string, id: string): void {
  send(sessionId, { type: 'prompt', message: `${STOP_COMMAND} ${id}` });
  runners.update(sessionId, (current) => ({
    ...current,
    stopRequested: [...current.stopRequested.filter((known) => known !== id), id],
  }));
}

export interface RunnerRunsPayload {
  runs: RunnerRunView[];
}

/** The plugin's session data channel: 'runner_runs' payloads into the store. */
export const runnerRunsChannel = runners.channel<RunnerRunsPayload>({
  channel: RUNNER_RUNS_TYPE,
  parse(input) {
    if (!isRecord(input) || !Array.isArray(input.runs)) return null;
    return { runs: input.runs.filter(isRecord) as unknown as RunnerRunView[] };
  },
  reduce(current, { runs }) {
    // A stop request is spent once the runner reports an exit or leaves the feed.
    const stillRunning = new Set(runs.filter((run) => run.state === 'running').map((run) => run.id));
    return { runs, stopRequested: current.stopRequested.filter((id) => stillRunning.has(id)) };
  },
});
