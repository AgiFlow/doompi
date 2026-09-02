import { Button, Dot } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import type { RunnerRunView } from '../types/webRunners.ts';
import { formatRunnerUptime } from './format.ts';
import { runnerLogTab } from './RunnerLogPanel.tsx';
import { requestRunnerStop, runners } from './runnersStore.ts';
import { useRunnerTail } from './runnerTail.ts';

const TICK_MS = 10_000;

/**
 * The runners group's body in the activity dock: what this session has up
 * right now.
 *
 * Only running runners are listed. A finished one leaves the moment it exits,
 * because the dock answers "what is happening", and a rail that keeps ten
 * completed playwright calls around buries the one command still working. The
 * runtime keeps every record; `doom-runner list` and the run's own log tab are
 * where a finished run is read.
 */
export function RunnersActivitySection({ sessionId, sendSessionFrame, openTransientTab }: WebPluginSlotProps) {
  const session = useStore(runners.store, (state) => runners.select(state, sessionId));
  const running = session.runs.filter((run) => run.state === 'running');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (running.length === 0) {
    return (
      <p data-testid="activity-summary-runners" className="px-1 text-[10px] text-doom-faint">
        idle
      </p>
    );
  }

  return (
    <div data-testid="activity-runner-runs" className="flex flex-col gap-0.5">
      {running.map((run: RunnerRunView) => (
        <RunnerRow
          key={run.id}
          run={run}
          now={now}
          stopRequested={session.stopRequested.includes(run.id)}
          sessionId={sessionId}
          sendSessionFrame={sendSessionFrame}
          openTransientTab={openTransientTab}
        />
      ))}
    </div>
  );
}

/**
 * One running runner: its name, how long it has been up, a stop control, and
 * one line of what it is doing. Its own component because the tail line is a
 * subscription per row, and a row that scrolls out of the dock closes it.
 */
function RunnerRow({
  run,
  now,
  stopRequested,
  sessionId,
  sendSessionFrame,
  openTransientTab,
}: {
  run: RunnerRunView;
  now: number;
  stopRequested: boolean;
} & Pick<WebPluginSlotProps, 'sessionId' | 'sendSessionFrame' | 'openTransientTab'>) {
  const tail = useRunnerTail(sessionId, run.id, run.state === 'running');
  return (
    <Button
      variant="ghost"
      size="card"
      data-testid={`activity-runner-${run.id}`}
      data-runner-tone="running"
      title="open this runner's log"
      onClick={() => {
        if (sessionId === null) return;
        openTransientTab(runnerLogTab(run));
      }}
      className="min-w-0 gap-0.5 rounded-[5px] px-1 py-1 hover:bg-doom-panel"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Dot tone="yellow" pulse />
        <span className="min-w-0 flex-1 truncate text-left text-[10px] font-bold text-doom-hi">{run.name}</span>
        <span className="shrink-0 text-[9px] text-doom-faint">
          {formatRunnerUptime(run.startedAt, now)}
          {run.interactive ? ' · tty' : ''}
        </span>
        {sessionId !== null ? (
          <Button
            asChild
            variant={stopRequested ? 'outline' : 'danger-outline'}
            size="xs"
            data-testid={`activity-runner-stop-${run.id}`}
            data-stopping={stopRequested}
            title={
              stopRequested ? 'stop requested; the runner reports its own exit' : 'ask the runtime to stop this runner'
            }
            className="px-1.5 text-[8px] font-bold"
          >
            {/* The row is already a button, so the stop control lends it
                the primitive's styling rather than nesting a second one. */}
            <span
              role="button"
              tabIndex={stopRequested ? -1 : 0}
              aria-disabled={stopRequested}
              onClick={(event) => {
                event.stopPropagation();
                if (!stopRequested) requestRunnerStop(sendSessionFrame, sessionId, run.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                if (!stopRequested) requestRunnerStop(sendSessionFrame, sessionId, run.id);
              }}
            >
              {stopRequested ? 'stopping…' : 'stop'}
            </span>
          </Button>
        ) : null}
      </span>
      {/* What it is doing, falling back to what it was asked to do until the
          first line of output arrives. */}
      <span
        data-testid={`activity-runner-detail-${run.id}`}
        data-detail={tail === undefined ? 'command' : 'tail'}
        className="truncate pl-3 text-left text-[9px] text-doom-faint"
      >
        {tail ?? run.command}
      </span>
    </Button>
  );
}
