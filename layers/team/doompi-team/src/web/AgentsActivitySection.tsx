import { Button, Dot, type DotTone } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import type { SubagentRun } from '../types/webSubagents.ts';
import { agentThreadTab } from './AgentThreadPanel.tsx';
import { subagentsTab } from './SubagentsPanel.tsx';
import { openCatalog } from './catalogStore.ts';
import { formatRunDuration } from './format.ts';
import { activityRuns, isTerminalRun, subagents } from './subagentsStore.ts';

const TICK_MS = 10_000;

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
 * row that opens the run's own conversation in a temporary tab. This replaces
 * the runtime's footer one-liner, which only says whether anything is running.
 */
export function AgentsActivitySection({ sessionId, openTransientTab }: WebPluginSlotProps) {
  const runs = useStore(subagents.store, (state) => activityRuns(subagents.select(state, sessionId)));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (runs.length === 0) {
    return (
      <div className="flex items-center gap-2 px-1">
        <p data-testid="activity-summary-agents" className="text-[10px] text-doom-faint">
          idle
        </p>
        <Button
          variant="link"
          size="xs"
          data-testid="activity-agents-launch"
          className="px-0"
          onClick={() => {
            if (sessionId === null) return;
            openCatalog(sessionId);
            openTransientTab(subagentsTab());
          }}
        >
          launch an agent
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="activity-agent-runs" className="flex flex-col gap-0.5">
      {runs.map((run) => (
        <Button
          key={run.runId}
          variant="ghost"
          size="card"
          data-testid={`activity-run-${run.runId}`}
          data-run-state={run.state}
          title="open this run's conversation"
          onClick={() => {
            if (sessionId === null) return;
            openTransientTab(agentThreadTab(run));
          }}
          className="min-w-0 gap-0.5 rounded-[5px] px-1 py-1 hover:bg-doom-panel"
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
        </Button>
      ))}
    </div>
  );
}
