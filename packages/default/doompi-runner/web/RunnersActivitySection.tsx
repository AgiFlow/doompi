import { Button, ChevronDownIcon, ChevronRightIcon, Dot, type DotTone } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import type { RunnerRunView } from '../src/types/webRunners.ts';
import { formatRunnerUptime } from './format.ts';
import { requestRunnerStop, runners } from './runnersStore.ts';

const TICK_MS = 10_000;

type RunnerTone = 'running' | 'done' | 'failed' | 'stopped';

const TONE_DOT: Readonly<Record<RunnerTone, DotTone>> = {
  running: 'yellow',
  done: 'green',
  failed: 'red',
  stopped: 'muted',
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

/** One fact of an opened run, on its own line so nothing is truncated away. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 gap-2">
      <span className="w-11 shrink-0 text-[9px] text-doom-faint">{label}</span>
      <span className="min-w-0 flex-1 break-all text-[9px] text-doom-dim">{value}</span>
    </span>
  );
}

/**
 * The runners group's body in the activity dock: the session's supervised
 * commands, with a stop control while one is running. This replaces the
 * runtime's footer count, which only says how many are up.
 */
export function RunnersActivitySection({ sessionId, sendSessionFrame }: WebPluginSlotProps) {
  const session = useStore(runners.store, (state) => runners.select(state, sessionId));
  const { runs, stopRequested: stopping } = session;
  // Which run the reader opened. The dock is narrow, so a row's command, cwd
  // and log path are all elided; opening one is the only way to read them.
  const [openId, setOpenId] = useState<string | null>(null);
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
            data-open={openId === run.id}
            className="flex min-w-0 flex-col gap-0.5 rounded-[5px] px-1 py-1"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                data-testid={`activity-runner-open-${run.id}`}
                aria-expanded={openId === run.id}
                title={openId === run.id ? 'hide this runner' : 'show this runner in full'}
                onClick={() => setOpenId((current) => (current === run.id ? null : run.id))}
                className="flex h-3 w-3 shrink-0 items-center justify-center rounded text-doom-faint outline-none hover:text-doom-hi focus-visible:text-doom-hi"
              >
                {openId === run.id ? (
                  <ChevronDownIcon className="h-2.5 w-2.5" />
                ) : (
                  <ChevronRightIcon className="h-2.5 w-2.5" />
                )}
              </button>
              <Dot tone={TONE_DOT[tone]} pulse={tone === 'running'} />
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
                <Button
                  variant={stopRequested ? 'outline' : 'danger-outline'}
                  size="xs"
                  data-testid={`activity-runner-stop-${run.id}`}
                  data-stopping={stopRequested}
                  disabled={stopRequested}
                  title={
                    stopRequested
                      ? 'stop requested; the runner reports its own exit'
                      : 'ask the runtime to stop this runner'
                  }
                  onClick={() => requestRunnerStop(sendSessionFrame, sessionId, run.id)}
                  className="px-1.5 text-[8px] font-bold"
                >
                  {stopRequested ? 'stopping…' : 'stop'}
                </Button>
              ) : null}
            </span>
            <span className={`truncate pl-6 text-[9px] ${tone === 'failed' ? 'text-doom-red' : 'text-doom-faint'}`}>
              {detail(run, tone)}
            </span>
            {openId === run.id ? (
              <div data-testid={`activity-runner-detail-${run.id}`} className="flex flex-col gap-0.5 pt-1 pl-6">
                <DetailRow label="command" value={run.command} />
                <DetailRow label="cwd" value={run.cwd} />
                <DetailRow
                  label="runner"
                  value={`${run.backend} · pid ${String(run.pid)}${run.interactive ? ' · tty' : ''}`}
                />
                {/* The cockpit only ever sees a bounded tail, so the whole log
                    is named rather than implied. */}
                <DetailRow label="log" value={run.logPath} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
