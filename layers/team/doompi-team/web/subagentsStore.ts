import { defineSessionStore, type SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import { SUBAGENT_RUNS_TYPE, type SubagentRun } from '../src/types/webSubagents.ts';

/** The runtime's slash verb that files a stop request for one run. */
const STOP_COMMAND = '/subagents-stop';

const TERMINAL_STATES: ReadonlySet<SubagentRun['state']> = new Set(['done', 'failed', 'stopped']);

export function isTerminalRun(run: SubagentRun): boolean {
  return TERMINAL_STATES.has(run.state);
}

/** One session's record: the fleet the hub last reported plus what this page did with it. */
export interface SubagentsSession {
  /** The fleet the hub last reported; presented order preserved. */
  runs: SubagentRun[];
  /** Finished runs the reader cleared from the grid; they stay on disk and in the hub's feed. */
  dismissed: string[];
  /** Runs a stop was asked for and that have not yet reported a final state. */
  stopRequested: string[];
  /** The run whose drawer the subagents tab shows. */
  openRunId: string | undefined;
}

export const subagents = defineSessionStore<SubagentsSession>({
  runs: [],
  dismissed: [],
  stopRequested: [],
  openRunId: undefined,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function without(list: readonly string[], runId: string): string[] {
  return list.filter((id) => id !== runId);
}

/** The session's runs minus the ones the reader dismissed; the reported list itself while nothing is. */
export function visibleRuns(session: SubagentsSession): SubagentRun[] {
  return session.dismissed.length === 0
    ? session.runs
    : session.runs.filter((run) => !session.dismissed.includes(run.runId));
}

/**
 * Asks the runtime to stop a run, through the same slash verb the TUI uses.
 * Pi executes extension commands at once even mid-turn, so this works whether
 * the main agent is idle or blocked on the run. The request is remembered
 * until the run reports a final state; the runtime, not this click, decides
 * when that is.
 */
export function requestRunStop(send: SessionFrameSender, sessionId: string, runId: string): void {
  send(sessionId, { type: 'prompt', message: `${STOP_COMMAND} ${runId}` });
  subagents.update(sessionId, (current) => ({
    ...current,
    stopRequested: [...without(current.stopRequested, runId), runId],
  }));
}

/** Hides a finished run from this page; nothing is deleted. */
export function dismissRun(sessionId: string, runId: string): void {
  subagents.update(sessionId, (current) => ({
    ...current,
    dismissed: [...without(current.dismissed, runId), runId],
    openRunId: current.openRunId === runId ? undefined : current.openRunId,
  }));
}

export function openRun(sessionId: string, runId: string | undefined): void {
  subagents.update(sessionId, (current) => ({ ...current, openRunId: runId }));
}

export interface SubagentRunsPayload {
  runs: SubagentRun[];
}

/** The plugin's session data channel: 'subagent_runs' payloads into the store. */
export const subagentRunsChannel = subagents.channel<SubagentRunsPayload>({
  channel: SUBAGENT_RUNS_TYPE,
  parse(input) {
    if (!isRecord(input) || !Array.isArray(input.runs)) return null;
    return { runs: input.runs.filter(isRecord) as unknown as SubagentRun[] };
  },
  reduce(current, { runs }) {
    const present = new Map(runs.map((run) => [run.runId, run]));
    // A stop request is spent once the run reports a final state or leaves
    // the feed; a dismissal is forgotten once the run is gone from the feed.
    const stopRequested = current.stopRequested.filter((runId) => {
      const run = present.get(runId);
      return run !== undefined && !isTerminalRun(run);
    });
    const dismissed = current.dismissed.filter((runId) => present.has(runId));
    return { ...current, runs, stopRequested, dismissed };
  },
});
