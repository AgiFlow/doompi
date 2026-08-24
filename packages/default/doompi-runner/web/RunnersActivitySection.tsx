import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import type { RunnerRunView } from '../src/types/webRunners.ts';
import { formatRunnerUptime } from './format.ts';
import { isStopRequested, requestRunnerStop, runnersStore, sessionRunners } from './runnersStore.ts';

const TICK_MS = 10_000;

type RunnerTone = 'running' | 'done' | 'failed' | 'stopped';

const TONE_DOT: Readonly<Record<RunnerTone, string>> = {
  running: 'bg-doom-yellow',
  done: 'bg-doom-green',
  failed: 'bg-doom-red',
  stopped: 'bg-doom-faint/40',
};

function toneOf(run: RunnerRunView): RunnerTone {
  if (run.state === 'running') return 'running';
  if (run.exit === undefined) return 'stopped';
  if (run.exit.reason === 'stopped') return 'stopped';
  return run.exit.reason === 'completed' && (run.exit.code === 0 || run.exit.code === null) ? 'done' : 'failed';
}

/** The one-liner under a row: the command while it runs, how it ended once it has. */
function detail(run: RunnerRunView, tone: RunnerTone): string {
  if (tone === 'running' || run.exit === undefined) return run.command;
  const code = run.exit.code === null ? '' : ` · exit ${String(run.exit.code)}`;
  const reason = run.exit.stopReason === undefined ? '' : ` · ${run.exit.stopReason}`;
  return `${run.exit.reason.replace('_', ' ')}${code}${reason} · ${run.command}`;
}

function span(run: RunnerRunView, now: number): string {
  const end = run.exit === undefined ? now : Date.parse(run.exit.finishedAt);
  return formatRunnerUptime(run.startedAt, Number.isFinite(end) ? end : now);
}

/**
 * The runners group's body in the activity dock: the session's supervised
 * commands, with a stop control while one is running. This replaces the
 * runtime's footer count, which only says how many are up.
 */
export function RunnersActivitySection({ sessionId }: WebPluginSlotProps) {
  const runs = useStore(runnersStore, (state) => sessionRunners(state, sessionId));
  const stopping = useStore(runnersStore, (state) =>
    sessionId === null ? [] : runs.filter((run) => isStopRequested(state, sessionId, run.id)).map((run) => run.id),
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (runs.length === 0) {
    return (
      <p data-testid="activity-summary-runners" className="px-1 text-[10px] text-doom-faint">
        idle
      </p>
    );
  }

  return (
    <div data-testid="activity-runner-runs" className="flex flex-col gap-0.5">
      {runs.map((run) => {
        const tone = toneOf(run);
        const stopRequested = stopping.includes(run.id);
        return (
          <div
            key={run.id}
            data-testid={`activity-runner-${run.id}`}
            data-runner-tone={tone}
            className="flex min-w-0 flex-col gap-0.5 rounded-[5px] px-1 py-1"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
              <span
                className={`min-w-0 flex-1 truncate text-[10px] font-bold ${
                  tone === 'running' ? 'text-doom-hi' : 'text-doom-dim'
                }`}
              >
                {run.name}
              </span>
              <span className="shrink-0 text-[9px] text-doom-faint">
                {span(run, now)}
                {run.interactive ? ' · tty' : ''}
              </span>
              {tone === 'running' && sessionId !== null ? (
                <button
                  type="button"
                  data-testid={`activity-runner-stop-${run.id}`}
                  data-stopping={stopRequested}
                  disabled={stopRequested}
                  title={
                    stopRequested
                      ? 'stop requested; the runner reports its own exit'
                      : 'ask the runtime to stop this runner'
                  }
                  onClick={() => requestRunnerStop(sessionId, run.id)}
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[8px] font-bold ${
                    stopRequested
                      ? 'border-doom-border text-doom-faint'
                      : 'border-[#6B3A3A] text-doom-red hover:bg-[#332428]'
                  }`}
                >
                  {stopRequested ? 'stopping…' : 'stop'}
                </button>
              ) : null}
            </span>
            <span className={`truncate pl-3 text-[9px] ${tone === 'failed' ? 'text-doom-red' : 'text-doom-faint'}`}>
              {detail(run, tone)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
