import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button, StatusBadge, Textarea } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { type FormEvent, useEffect, useState } from 'react';

import type { SubagentRun } from '../../types/webSubagents';
import { isTerminalRun, requestRunSteer, subagents } from '../stores/subagentsStore';
import { elapsedRun, RUN_BADGE, RunControl } from './RunControl';

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
  const [guidance, setGuidance] = useState('');

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const firstLine = run?.task.split('\n').find((line) => line.trim() !== '') ?? '';
  const canSteer = sessionId !== null && run !== undefined && !isTerminalRun(run);
  const submitGuidance = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const message = guidance.trim();
    if (!canSteer || !message) return;
    requestRunSteer(sendSessionFrame, sessionId, runId, message);
    setGuidance('');
  };

  return (
    <div data-testid="agent-thread-panel" className="flex min-h-0 flex-1 flex-col">
      <div
        data-testid="agent-thread-header"
        className="flex h-10 shrink-0 items-center gap-2.5 border-b border-doom-border-soft px-[26px]"
      >
        {run ? (
          <>
            <span data-testid="agent-thread-agent" className="shrink-0 truncate text-sm font-bold text-doom-hi">
              {run.agent}
            </span>
            <StatusBadge tone={RUN_BADGE[run.state].tone} data-testid="agent-thread-state">
              {RUN_BADGE[run.state].label}
            </StatusBadge>
            <span className="shrink-0 text-xs text-doom-faint">{elapsedRun(run, now)}</span>
            {run.model ? (
              <span className="shrink-0 text-xs text-doom-faint">{run.model.split('/').pop() ?? run.model}</span>
            ) : null}
            <span data-testid="agent-thread-task" className="min-w-0 flex-1 truncate text-xs text-doom-dim">
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
          <span data-testid="agent-thread-gone" className="text-xs text-doom-faint">
            run {runId.slice(0, 8)} is no longer listed; its transcript stays readable
          </span>
        )}
      </div>
      {renderThread(runId)}
      {canSteer ? (
        <form
          data-testid="agent-steer-composer"
          className="shrink-0 border-t border-doom-border-soft bg-doom-rail px-[26px] pt-3 pb-2.5"
          onSubmit={submitGuidance}
        >
          <div className="rounded-lg border border-doom-border bg-doom-deep transition-colors focus-within:border-doom-blue/60">
            <div className="flex min-w-0 items-start gap-2.5 px-3.5 pt-3">
              <span className="mt-[3px] shrink-0 select-none text-base leading-none text-doom-green">&gt;</span>
              <Textarea
                variant="bare"
                data-testid="agent-steer-input"
                aria-label="Steering guidance"
                rows={2}
                value={guidance}
                placeholder="Guide this agent…"
                className="min-w-0 flex-1 text-base leading-relaxed"
                onChange={(event) => setGuidance(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 px-3.5 pt-2 pb-2.5">
              <span data-testid="agent-steer-hint" className="text-xs text-doom-faint">
                guidance reaches this run while it is still working
              </span>
              <span className="min-w-0 flex-1" />
              <Button
                data-testid="agent-steer-submit"
                type="submit"
                variant="primary"
                size="md"
                className="px-3.5"
                disabled={guidance.trim() === ''}
              >
                send
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </div>
  );
}
