import { Dot, type DotTone } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import type { SubagentRun } from '../src/types/webSubagents.ts';
import { formatRunDuration } from './format.ts';
import { isTerminalRun, openRun, subagents, visibleRuns } from './subagentsStore.ts';

const TICK_MS = 10_000;
const SUBAGENTS_TAB = 'subagents';

const STATE_TONE: Readonly<Record<SubagentRun['state'], DotTone>> = {
  queued: 'muted',
  running: 'yellow',
  done: 'green',
  failed: 'red',
  stopped: 'muted',
};

function elapsed(run: SubagentRun, now: number): string {
  const end = run.endedAt ?? (isTerminalRun(run) ? run.lastUpdate : now);
  return formatRunDuration(Math.max(0, end - run.startedAt));
}

/** The one-liner under a row: what the run is doing, or how it ended. */
function detail(run: SubagentRun): string {
  if (run.state === 'failed' && run.error) return run.error;
  if (run.summary) return run.summary.split('\n').find((line) => line.trim() !== '') ?? '';
  return run.currentTool ?? run.tail.at(-1) ?? run.state;
}

/**
 * The agents group's body in the activity dock: the session's runs, each a
 * row that opens the subagents tab on that run's drawer. This replaces the
 * runtime's footer one-liner, which only says whether anything is running.
 */
export function AgentsActivitySection({ sessionId, openTab }: WebPluginSlotProps) {
  const runs = useStore(subagents.store, (state) => visibleRuns(subagents.select(state, sessionId)));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (runs.length === 0) {
    return (
      <p data-testid="activity-summary-agents" className="px-1 text-[10px] text-doom-faint">
        idle
      </p>
    );
  }

  return (
    <div data-testid="activity-agent-runs" className="flex flex-col gap-0.5">
      {runs.map((run) => (
        <button
          key={run.runId}
          type="button"
          data-testid={`activity-run-${run.runId}`}
          data-run-state={run.state}
          title="open this run in the subagents tab"
          onClick={() => {
            if (sessionId === null) return;
            openRun(sessionId, run.runId);
            openTab(SUBAGENTS_TAB);
          }}
          className="flex min-w-0 flex-col gap-0.5 rounded-[5px] px-1 py-1 text-left hover:bg-doom-panel"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Dot tone={STATE_TONE[run.state]} pulse={run.state === 'running'} />
            <span
              className={`min-w-0 flex-1 truncate text-[10px] font-bold ${isTerminalRun(run) ? 'text-doom-dim' : 'text-doom-hi'}`}
            >
              {run.agent}
            </span>
            <span className="shrink-0 text-[9px] text-doom-faint">
              {elapsed(run, now)}
              {run.toolCount !== undefined ? ` · ${run.toolCount} tools` : ''}
            </span>
          </span>
          <span className={`truncate pl-3 text-[9px] ${run.state === 'failed' ? 'text-doom-red' : 'text-doom-faint'}`}>
            {detail(run)}
          </span>
        </button>
      ))}
    </div>
  );
}
