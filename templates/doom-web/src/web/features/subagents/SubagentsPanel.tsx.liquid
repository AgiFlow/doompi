import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import type { SubagentRun, SubagentRunState } from '../../../types/hub.ts';
import { abbreviateCwd, formatRunDuration } from '../../lib/sessionSummary.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';
import { subagentsStore } from '../../stores/subagentsStore.ts';

const TICK_MS = 10_000;

const BADGE: Readonly<Record<SubagentRunState, { label: string; className: string; border: string }>> = {
  queued: { label: 'QUEUED', className: 'bg-doom-panel text-doom-faint', border: 'border-doom-border' },
  running: { label: 'RUNNING', className: 'bg-[#312A1C] text-doom-yellow', border: 'border-[#574427]' },
  done: { label: 'DONE', className: 'bg-[#262E1E] text-doom-green', border: 'border-doom-border' },
  failed: { label: 'FAILED', className: 'bg-[#332428] text-doom-red', border: 'border-[#6B3A3A]' },
  stopped: { label: 'STOPPED', className: 'bg-doom-panel text-doom-faint', border: 'border-doom-border' },
};

function elapsed(run: SubagentRun, now: number): string {
  const end = run.endedAt ?? (run.state === 'running' || run.state === 'queued' ? now : run.lastUpdate);
  return formatRunDuration(Math.max(0, end - run.startedAt));
}

/** The card's work line: a task binding wins; otherwise the delegation prompt. */
function WorkLine({ run }: { run: SubagentRun }) {
  const firstLine = run.task.split('\n').find((line) => line.trim() !== '') ?? '';
  if (run.taskRef) {
    return (
      <div className="flex items-center gap-2 px-3 pb-2.5">
        <span className="shrink-0 rounded-[3px] border border-doom-violet/40 bg-doom-violet/10 px-1.5 py-0.5 text-[8px] font-bold text-doom-violet">
          TASK {run.taskRef}
        </span>
        <span data-testid="run-work" className="truncate text-[10px] text-doom-hi">
          {firstLine}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 pb-2.5">
      <span className="shrink-0 text-[8px] font-bold text-doom-faint">PROMPT</span>
      <span data-testid="run-work" className="truncate text-[10px] text-doom-dim">
        {firstLine}
      </span>
    </div>
  );
}

/** What fills the tail: live output while running, the report when done, the error when failed. */
function tailLines(run: SubagentRun): { text: string; className: string }[] {
  if (run.state === 'failed' && run.error) {
    return [
      ...run.tail.map((line) => ({ text: line, className: 'text-doom-dim' })),
      { text: run.error, className: 'text-doom-red' },
    ];
  }
  if (run.summary) {
    return run.summary
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(0, 6)
      .map((line) => ({ text: line, className: 'text-doom-text' }));
  }
  const lines = run.tail.map((line) => ({ text: line, className: 'text-doom-dim' }));
  if (run.currentTool) lines.push({ text: run.currentTool, className: 'text-doom-dim' });
  return lines;
}

function RunCard({ run, now, onOpen }: { run: SubagentRun; now: number; onOpen: () => void }) {
  const badge = BADGE[run.state];
  return (
    <button
      type="button"
      data-testid={`run-card-${run.runId}`}
      data-run-state={run.state}
      onClick={onOpen}
      className={`flex min-h-[210px] flex-col overflow-hidden rounded-md border bg-doom-panel text-left ${badge.border} hover:border-doom-blue/50`}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span data-testid="run-agent" className="text-[12px] font-bold text-doom-hi">
          {run.agent}
        </span>
        <span className="min-w-0 flex-1" />
        <span className="text-[9px] text-doom-faint">{elapsed(run, now)}</span>
        <span
          data-testid="run-state"
          className={`rounded-[3px] px-[7px] py-[3px] text-[9px] font-bold ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>
      <WorkLine run={run} />
      <div className="flex flex-1 flex-col gap-1 overflow-hidden border-t border-doom-border-soft bg-doom-deep px-3 py-2.5">
        {tailLines(run).map((line, index) => (
          <span key={index} className={`truncate text-[10px] ${line.className}`}>
            {line.text}
          </span>
        ))}
        {run.state === 'running' ? <span className="mt-0.5 inline-block h-[11px] w-1.5 bg-doom-blue" /> : null}
      </div>
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="text-[9px] text-doom-faint">
          {run.toolCount !== undefined ? `${run.toolCount} tools` : '—'}
          {run.tokens !== undefined ? ` · ${run.tokens.toLocaleString()} tk` : ''}
          {run.model ? ` · ${run.model.split('/').pop() ?? run.model}` : ''}
        </span>
        <span className="min-w-0 flex-1" />
        <span className="text-[9px] font-bold text-doom-blue">detail</span>
      </div>
    </button>
  );
}

function DrawerRow({ label, value, tone = 'text-doom-dim' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="w-11 shrink-0 text-[9px] text-doom-faint">{label}</span>
      <span className={`min-w-0 truncate text-[10px] ${tone}`}>{value}</span>
    </div>
  );
}

function RunDrawer({ run, now, onClose }: { run: SubagentRun; now: number; onClose: () => void }) {
  const badge = BADGE[run.state];
  const output = run.summary ?? run.tail.join('\n');
  return (
    <aside
      data-testid="run-drawer"
      className="flex w-[440px] shrink-0 flex-col overflow-hidden border-l border-doom-border bg-doom-rail"
    >
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-doom-border px-4">
        <span data-testid="drawer-agent" className="text-[13px] font-bold text-doom-hi">
          {run.agent}
        </span>
        <span className={`rounded-[3px] px-[7px] py-[3px] text-[9px] font-bold ${badge.className}`}>{badge.label}</span>
        <span className="min-w-0 flex-1" />
        <span className="text-[10px] text-doom-faint">{elapsed(run, now)}</span>
        <button
          type="button"
          data-testid="drawer-close"
          onClick={onClose}
          className="text-[11px] text-doom-faint hover:text-doom-hi"
        >
          ✕
        </button>
      </div>
      <div className="flex flex-col gap-1.5 px-4 py-2.5">
        <DrawerRow label="run" value={run.runId.slice(0, 8)} />
        {run.taskRef ? <DrawerRow label="task" value={run.taskRef} tone="text-doom-violet" /> : null}
        {run.model ? <DrawerRow label="model" value={run.model} /> : null}
        <DrawerRow label="cwd" value={abbreviateCwd(run.cwd)} />
      </div>
      <div className="px-4 pb-2.5">
        <div className="flex flex-col gap-1 rounded-md border border-doom-border bg-doom-deep px-3 py-2.5">
          <span className="text-[8px] font-bold tracking-[0.14em] text-doom-faint">PROMPT FROM THE MAIN AGENT</span>
          <pre
            data-testid="drawer-task"
            className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-doom-text"
          >
            {run.task || '(no prompt recorded)'}
          </pre>
        </div>
      </div>
      <div className="flex items-center justify-between px-4 pb-1.5">
        <span className="text-[9px] font-bold tracking-[0.14em] text-doom-faint">
          {run.summary ? 'REPORT' : run.state === 'failed' ? 'FAILURE' : 'OUTPUT · live'}
        </span>
        <span className="text-[9px] text-doom-faint">
          {run.toolCount !== undefined ? `${run.toolCount} tools` : ''}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto border-t border-doom-border-soft bg-doom-deep px-4 py-3">
        <pre
          data-testid="drawer-output"
          className="whitespace-pre-wrap break-words text-[10px] leading-relaxed text-doom-text"
        >
          {run.state === 'failed' && run.error ? run.error : output || run.currentTool || '(nothing reported yet)'}
        </pre>
        {run.state === 'running' ? <span className="mt-1 inline-block h-[11px] w-1.5 bg-doom-blue" /> : null}
      </div>
    </aside>
  );
}

/**
 * The subagents tab: the focused session's fleet as a computed grid.
 *
 * Columns come from the available width (auto-fill over a 420px minimum), and
 * every card keeps a 210px minimum height with the tail absorbing the slack,
 * so short runs read as calmly as busy ones. Clicking a card opens the detail
 * drawer, which narrows the grid and lets it recompute.
 */
export function SubagentsPanel() {
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const runs = useStore(subagentsStore, (state) => (activeId === null ? [] : (state.bySession[activeId] ?? [])));
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const openRun = openRunId === null ? undefined : runs.find((run) => run.runId === openRunId);
  const runningTally = runs.filter((run) => run.state === 'running' || run.state === 'queued').length;
  const doneTally = runs.filter((run) => run.state === 'done').length;
  const failedTally = runs.filter((run) => run.state === 'failed' || run.state === 'stopped').length;

  return (
    <div data-testid="subagents-panel" className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-[26px] py-[18px]">
        <div className="flex items-center pb-3">
          <span className="text-[9px] font-bold tracking-[0.18em] text-doom-faint">SUBAGENTS · this session</span>
          <span className="min-w-0 flex-1" />
          <span data-testid="subagents-tally" className="text-[9px] text-doom-faint">
            {runs.length === 0 ? 'no runs yet' : `${runningTally} running · ${doneTally} done · ${failedTally} failed`}
          </span>
        </div>
        {runs.length === 0 ? (
          <div data-testid="subagents-empty" className="flex flex-1 items-center justify-center">
            <div className="flex w-[420px] flex-col items-center gap-2 text-center">
              <span className="text-[13px] font-bold text-doom-hi">no subagent runs yet</span>
              <span className="text-[11px] leading-relaxed text-doom-dim">
                the main agent starts them with its subagent tool; every run will show up here live.
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(420px,1fr))] gap-4">
              {runs.map((run) => (
                <RunCard key={run.runId} run={run} now={now} onOpen={() => setOpenRunId(run.runId)} />
              ))}
            </div>
            <span className="pt-3 text-[9px] text-doom-faint">
              click a card for the run detail · finished runs leave the grid after 10m
            </span>
          </>
        )}
      </div>
      {openRun ? <RunDrawer run={openRun} now={now} onClose={() => setOpenRunId(null)} /> : null}
    </div>
  );
}
