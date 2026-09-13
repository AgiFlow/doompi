import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import {
  Button,
  Dot,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  PlusIcon,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';

import type { RunnerRunView } from '../../types/webRunners';
import { useRunnerTail } from '../hooks/runnerTail';
import { formatRunnerUptime } from '../lib/format';
import { RUNNER_SHELL_REQUEST } from '../lib/launchLine';
import { requestRunnerStart, requestRunnerStop, runners } from '../stores/runnersStore';
import { LaunchRunnerDialog } from './LaunchRunnerDialog';
import { runnerLogTab } from './RunnerLogPanel';
import { runnerShellTab } from './RunnerShellPanel';

const TICK_MS = 10_000;
const SHELL_LAUNCH_TIMEOUT_MS = 30_000;
const RUNNERS_TAB_ID = 'runner-runs';

/** The temporary tab the dock's runners group opens from its own name. */
export function runnersTab(): TransientTab {
  return { id: RUNNERS_TAB_ID, label: 'runners', panel: RunnersPanel };
}

/**
 * Everything this session has up, one card each.
 *
 * The dock's rail gives a runner one line, which is enough to notice it and
 * not enough to work with it. This is the same set with room: the command in
 * full, where it runs, and the last thing it said.
 *
 * Running runners only, the same rule the rail follows. A finished run leaves
 * the moment it exits, because this answers "what is happening"; its log stays
 * readable from its own tab, and `doom-runner list` is where history lives.
 */
export function RunnersPanel({ sessionId, sendSessionFrame, openTransientTab }: WebPluginSlotProps) {
  const session = useStore(runners.store, (state) => runners.select(state, sessionId));
  const running = session.runs.filter((run) => run.state === 'running');
  const [now, setNow] = useState(() => Date.now());
  const [launching, setLaunching] = useState(false);
  const shellBaseline = useRef<ReadonlySet<string> | null>(null);
  const shellLaunchTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Somewhere to start from, borrowed from whatever is already up.
  const defaultCwd = running[0]?.cwd;

  const startShell = (): void => {
    if (sessionId === null) return;
    shellBaseline.current = new Set(session.runs.map((run) => run.id));
    clearTimeout(shellLaunchTimeout.current);
    shellLaunchTimeout.current = setTimeout(() => {
      shellBaseline.current = null;
    }, SHELL_LAUNCH_TIMEOUT_MS);
    requestRunnerStart(sendSessionFrame, sessionId, RUNNER_SHELL_REQUEST);
  };

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const baseline = shellBaseline.current;
    if (baseline === null) return;
    const shell = session.runs.find((run) => run.state === 'running' && run.interactive && !baseline.has(run.id));
    if (!shell) return;
    shellBaseline.current = null;
    clearTimeout(shellLaunchTimeout.current);
    openTransientTab(runnerShellTab(shell));
  }, [openTransientTab, session.runs]);

  useEffect(() => () => clearTimeout(shellLaunchTimeout.current), []);

  return (
    <div data-testid="runners-panel" className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex min-h-11 shrink-0 items-center gap-2.5 border-b border-doom-border-soft px-3 sm:h-11 sm:px-[26px]">
        <span className="text-sm font-bold text-doom-hi">runners</span>
        <span data-testid="runners-panel-count" className="text-xs text-doom-faint">
          {running.length === 0 ? 'nothing running' : `${String(running.length)} running`}
        </span>
        <span className="min-w-0 flex-1" />
        {sessionId === null ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-testid="runners-panel-launch"
                title="launch a runner"
                aria-label="launch a runner"
                className="text-doom-faint hover:text-doom-hi"
              >
                <PlusIcon className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-testid="runners-panel-launch-menu">
              <DropdownMenuItem data-testid="runners-panel-start-shell" onSelect={startShell}>
                start shell
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="runners-panel-run-command" onSelect={() => setLaunching(true)}>
                run command
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {running.length === 0 ? (
        <EmptyState
          data-testid="runners-panel-empty"
          className="px-4 py-8"
          title="nothing running"
          description="a command that outlives its turn moves to a runner and appears here while it works."
        >
          {sessionId === null ? null : (
            <Button
              variant="outline"
              size="xs"
              data-testid="runners-panel-launch-empty"
              onClick={() => setLaunching(true)}
              className="px-2 text-2xs font-bold"
            >
              launch a runner
            </Button>
          )}
        </EmptyState>
      ) : (
        <div
          data-testid="runners-panel-grid"
          className="grid grid-cols-1 gap-2.5 px-3 py-3 sm:grid-cols-2 sm:px-[26px] xl:grid-cols-3"
        >
          {running.map((run) => (
            <RunnerCard
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
      )}

      {launching && sessionId !== null ? (
        <LaunchRunnerDialog
          sessionId={sessionId}
          sendSessionFrame={sendSessionFrame}
          {...(defaultCwd === undefined ? {} : { defaultCwd })}
          onClose={() => setLaunching(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * One running runner. Its own component because the tail line is a
 * subscription per card, and a card that leaves the grid closes it.
 */
function RunnerCard({
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
    <div
      data-testid={`runners-card-${run.id}`}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-doom-border-soft bg-doom-panel p-2.5"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Dot tone="yellow" pulse />
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-doom-hi">{run.name}</span>
        <span className="shrink-0 text-2xs text-doom-faint">
          {formatRunnerUptime(run.startedAt, now)}
          {run.interactive ? ' · tty' : ''}
        </span>
      </div>

      <span className="min-w-0 break-all text-2xs leading-normal text-doom-dim">{run.command}</span>
      <span className="min-w-0 truncate text-2xs text-doom-faint">{run.cwd}</span>

      {/* What it is doing, falling back to what it was asked to do until the
          first line of output arrives. */}
      <span
        data-testid={`runners-card-detail-${run.id}`}
        data-detail={tail === undefined ? 'command' : 'tail'}
        className="min-w-0 truncate text-2xs text-doom-faint"
      >
        {tail ?? '…'}
      </span>

      <div className="flex items-center gap-1.5 pt-0.5">
        <Button
          variant="outline"
          size="xs"
          data-testid={`runners-card-log-${run.id}`}
          title="open this runner's log"
          onClick={() => openTransientTab(runnerLogTab(run))}
          className="px-2 text-2xs font-bold"
        >
          log
        </Button>
        {/* Only an interactive run has a pane to attach to. A plain one has
            nothing to type into, so it is not offered. */}
        {run.interactive && sessionId !== null ? (
          <Button
            variant="outline"
            size="xs"
            data-testid={`runners-card-shell-${run.id}`}
            title="attach to this runner's terminal"
            onClick={() => openTransientTab(runnerShellTab(run))}
            className="px-2 text-2xs font-bold"
          >
            shell
          </Button>
        ) : null}
        <span className="min-w-0 flex-1" />
        {sessionId !== null ? (
          <Button
            variant={stopRequested ? 'outline' : 'danger-outline'}
            size="xs"
            data-testid={`runners-card-stop-${run.id}`}
            disabled={stopRequested}
            title={
              stopRequested ? 'stop requested; the runner reports its own exit' : 'ask the runtime to stop this runner'
            }
            onClick={() => requestRunnerStop(sendSessionFrame, sessionId, run.id)}
            className="px-2 text-2xs font-bold"
          >
            {stopRequested ? 'stopping…' : 'stop'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
