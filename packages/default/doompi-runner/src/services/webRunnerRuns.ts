import type { RunnerRecord } from '../types/runnerRegistry';
import type { RunnerRunView } from '../types/webRunners.ts';
import { isRunnerRecord } from './runs/runnerRecord.ts';

/** How long a finished runner stays in the cockpit's feed after it exited. */
export const FINISHED_RUNNER_RETENTION_MS = 10 * 60 * 1000;

/** One on-disk metadata record, or undefined when the text is not a runner record. */
export function parseRunnerRecord(raw: string): RunnerRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRunnerRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined; // Mid-write or foreign file; the next scan settles it.
  }
}

export function toRunnerRunView(record: RunnerRecord): RunnerRunView {
  return {
    id: record.id,
    name: record.name,
    pid: record.pid,
    command: record.command,
    cwd: record.cwd,
    interactive: record.interactive,
    backend: record.backend,
    state: record.state,
    promoted: record.promoted,
    startedAt: record.startedAt,
    logPath: record.logPath,
    ...(record.exit
      ? {
          exit: {
            reason: record.exit.reason,
            code: record.exit.code,
            signal: record.exit.signal,
            ...(record.exit.stopReason === undefined ? {} : { stopReason: record.exit.stopReason }),
            finishedAt: record.exit.finishedAt,
          },
        }
      : {}),
  };
}

function finishedAt(record: RunnerRecord): number {
  const parsed = record.exit === undefined ? Number.NaN : Date.parse(record.exit.finishedAt);
  return Number.isFinite(parsed) ? parsed : Date.parse(record.startedAt);
}

/**
 * The feed the cockpit shows: running runners first, newest start first, then
 * the recently finished ones, newest exit first. Finished runners older than
 * the retention window are left out; the registry keeps them for the CLI.
 */
export function presentRunnerRuns(records: readonly RunnerRecord[], now: number): RunnerRunView[] {
  const running = records
    .filter((record) => record.state === 'running')
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const finished = records
    .filter((record) => record.state === 'completed' && now - finishedAt(record) <= FINISHED_RUNNER_RETENTION_MS)
    .sort((left, right) => finishedAt(right) - finishedAt(left));
  return [...running, ...finished].map(toRunnerRunView);
}
