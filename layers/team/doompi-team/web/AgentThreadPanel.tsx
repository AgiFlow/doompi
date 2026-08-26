import { StatusBadge } from '@agimon-ai/doompi-web-components';
import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import type { SubagentRun } from '../src/types/webSubagents.ts';
import { elapsedRun, RUN_BADGE, RunControl } from './RunControl.tsx';
import { isTerminalRun, subagents } from './subagentsStore.ts';

const TICK_MS = 10_000;
/** The tab id doubles as the URL segment, so it stays plain and unique across plugins. */
const TAB_ID_PREFIX = 'subagents-run-';

/** The temporary tab for one run; the host keeps this panel for as long as the tab is open. */
export function agentThreadTab(run: SubagentRun): TransientTab {
  const runId = run.runId;
  return {
    id: `${TAB_ID_PREFIX}${runId}`,
    label: run.agent,
    panel: (props: WebPluginSlotProps) => <AgentThreadPanel {...props} runId={runId} />,
  };
}

/**
 * A run's own conversation on the host's transcript, under a header with
 * what the grid card knows: state, elapsed, model, the prompt's first line,
 * and stop while the run is going. The run can leave the fleet feed before
 * the reader is done; the thread stays, and the header says so.
 */
export function AgentThreadPanel({
  sessionId,
  runId,
  sendSessionFrame,
  renderThread,
}: WebPluginSlotProps & { runId: string }) {
  const { runs, stopRequested } = useStore(subagents.store, (state) => subagents.select(state, sessionId));
  const run = runs.find((candidate) => candidate.runId === runId);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const firstLine = run?.task.split('\n').find((line) => line.trim() !== '') ?? '';

  return (
    <div data-testid="agent-thread-panel" className="flex min-h-0 flex-1 flex-col">
      <div
        data-testid="agent-thread-header"
        className="flex h-10 shrink-0 items-center gap-2.5 border-b border-doom-border-soft px-[26px]"
      >
        {run ? (
          <>
            <span data-testid="agent-thread-agent" className="shrink-0 truncate text-[12px] font-bold text-doom-hi">
              {run.agent}
            </span>
            <StatusBadge tone={RUN_BADGE[run.state].tone} data-testid="agent-thread-state">
              {RUN_BADGE[run.state].label}
            </StatusBadge>
            <span className="shrink-0 text-[10px] text-doom-faint">{elapsedRun(run, now)}</span>
            {run.model ? (
              <span className="shrink-0 text-[10px] text-doom-faint">{run.model.split('/').pop() ?? run.model}</span>
            ) : null}
            <span data-testid="agent-thread-task" className="min-w-0 flex-1 truncate text-[10px] text-doom-dim">
              {firstLine}
            </span>
            {sessionId !== null && !isTerminalRun(run) ? (
              <RunControl
                sessionId={sessionId}
                run={run}
                stopping={stopRequested.includes(run.runId)}
                send={sendSessionFrame}
              />
            ) : null}
          </>
        ) : (
          <span data-testid="agent-thread-gone" className="text-[10px] text-doom-faint">
            run {runId.slice(0, 8)} is no longer listed; its transcript stays readable
          </span>
        )}
      </div>
      {renderThread(runId)}
    </div>
  );
}
