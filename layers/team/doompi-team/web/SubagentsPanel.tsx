import {
  Button,
  CloseIcon,
  EmptyState,
  STATUS_EDGE,
  StatusBadge,
  type StatusTone,
  StreamCursor,
} from '@agimon-ai/doompi-web-components';
import type { SessionFrameSender, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useState,
} from 'react';
import type { SubagentRun, SubagentRunState } from '../src/types/webSubagents.ts';
import { abbreviateCwd, formatRunDuration } from './format.ts';
import { RUN_ACTIONS_SLOT } from './runActionsSlot.ts';
import { dismissRun, isTerminalRun, openRun, requestRunStop, subagents, visibleRuns } from './subagentsStore.ts';

const TICK_MS = 10_000;

/** One run state, in the host's shared outcome vocabulary. */
const BADGE: Readonly<Record<SubagentRunState, { label: string; tone: StatusTone }>> = {
  queued: { label: 'QUEUED', tone: 'neutral' },
  running: { label: 'RUNNING', tone: 'running' },
  done: { label: 'DONE', tone: 'ok' },
  failed: { label: 'FAILED', tone: 'error' },
  stopped: { label: 'STOPPED', tone: 'neutral' },
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
        <span data-testid="run-work" className="min-w-0 truncate text-[10px] text-doom-hi">
          {firstLine}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 pb-2.5">
      <span className="shrink-0 text-[8px] font-bold text-doom-faint">PROMPT</span>
      <span data-testid="run-work" className="min-w-0 truncate text-[10px] text-doom-dim">
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

/**
 * The one control a run offers: stop while it is active, clear once it is
 * not. Stop is a request the runtime acknowledges in its own time, so the
 * button reads "stopping" until the run's own status says otherwise.
 */
function RunControl({
  sessionId,
  run,
  stopping,
  send,
}: {
  sessionId: string;
  run: SubagentRun;
  stopping: boolean;
  send: SessionFrameSender;
}) {
  const act = (event: ReactMouseEvent, action: () => void): void => {
    event.stopPropagation();
    action();
  };
  if (isTerminalRun(run)) {
    return (
      <Button
        variant="outline"
        size="xs"
        data-testid={`run-clear-${run.runId}`}
        title="clear this run from the grid"
        onClick={(event) => act(event, () => dismissRun(sessionId, run.runId))}
      >
        clear
      </Button>
    );
  }
  return (
    <Button
      variant={stopping ? 'outline' : 'danger-outline'}
      size="xs"
      data-testid={`run-stop-${run.runId}`}
      data-stopping={stopping}
      disabled={stopping}
      title={stopping ? 'stop requested; the run reports its own final state' : 'ask the runtime to stop this run'}
      onClick={(event) => act(event, () => requestRunStop(send, sessionId, run.runId))}
    >
      {stopping ? 'stopping…' : 'stop'}
    </Button>
  );
}

function RunCard({
  sessionId,
  run,
  now,
  stopping,
  send,
  onOpen,
}: {
  sessionId: string;
  run: SubagentRun;
  now: number;
  stopping: boolean;
  send: SessionFrameSender;
  onOpen: () => void;
}) {
  const badge = BADGE[run.state];
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };
  // A div rather than a button: the card carries buttons of its own, and a
  // button cannot contain another.
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`run-card-${run.runId}`}
      data-run-state={run.state}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className={`flex min-h-[210px] min-w-0 cursor-pointer flex-col overflow-hidden rounded-md border bg-doom-panel text-left transition-colors outline-none ${STATUS_EDGE[badge.tone]} hover:border-doom-blue/50 focus-visible:border-doom-blue`}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span data-testid="run-agent" className="truncate text-[12px] font-bold text-doom-hi">
          {run.agent}
        </span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 text-[9px] text-doom-faint">{elapsed(run, now)}</span>
        <StatusBadge tone={badge.tone} data-testid="run-state">
          {badge.label}
        </StatusBadge>
      </div>
      <WorkLine run={run} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden border-t border-doom-border-soft bg-doom-deep px-3 py-2.5">
        {tailLines(run).map((line, index) => (
          <span key={index} className={`truncate text-[10px] ${line.className}`}>
            {line.text}
          </span>
        ))}
        {run.state === 'running' ? <StreamCursor className="mt-0.5 ml-0 h-[11px] w-1.5 translate-y-0" /> : null}
      </div>
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="truncate text-[9px] text-doom-faint">
          {run.toolCount !== undefined ? `${run.toolCount} tools` : '—'}
          {run.tokens !== undefined ? ` · ${run.tokens.toLocaleString()} tk` : ''}
          {run.model ? ` · ${run.model.split('/').pop() ?? run.model}` : ''}
        </span>
        <span className="min-w-0 flex-1" />
        <RunControl sessionId={sessionId} run={run} stopping={stopping} send={send} />
        <span className="text-[9px] font-bold text-doom-blue">detail</span>
      </div>
    </div>
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

function RunDrawer({
  sessionId,
  run,
  now,
  stopping,
  send,
  renderSlot,
  onClose,
}: {
  sessionId: string;
  run: SubagentRun;
  now: number;
  stopping: boolean;
  send: SessionFrameSender;
  renderSlot: WebPluginSlotProps['renderSlot'];
  onClose: () => void;
}) {
  const badge = BADGE[run.state];
  const output = run.summary ?? run.tail.join('\n');
  return (
    <aside
      data-testid="run-drawer"
      className="flex w-[440px] shrink-0 flex-col overflow-hidden border-l border-doom-border bg-doom-rail"
    >
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-doom-border px-4">
        <span data-testid="drawer-agent" className="truncate text-[13px] font-bold text-doom-hi">
          {run.agent}
        </span>
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        <span className="min-w-0 flex-1" />
        <span className="text-[10px] text-doom-faint">{elapsed(run, now)}</span>
        {renderSlot(RUN_ACTIONS_SLOT.slot)}
        <RunControl sessionId={sessionId} run={run} stopping={stopping} send={send} />
        <Button variant="ghost" size="icon" data-testid="drawer-close" title="close the run detail" onClick={onClose}>
          <CloseIcon className="h-3 w-3" />
        </Button>
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
        {run.state === 'running' ? <StreamCursor className="mt-1 ml-0 h-[11px] w-1.5 translate-y-0" /> : null}
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
export function SubagentsPanel({ sessionId, sendSessionFrame, renderSlot }: WebPluginSlotProps) {
  const runs = useStore(subagents.store, (state) => visibleRuns(subagents.select(state, sessionId)));
  const { openRunId, stopRequested } = useStore(subagents.store, (state) => subagents.select(state, sessionId));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const shownRun = openRunId === undefined ? undefined : runs.find((run) => run.runId === openRunId);
  const stopping = (run: SubagentRun): boolean => stopRequested.includes(run.runId);
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
          <EmptyState
            data-testid="subagents-empty"
            title="no subagent runs yet"
            description="the main agent starts them with its subagent tool; every run will show up here live."
          />
        ) : (
          <>
            <div data-testid="subagents-grid" className="grid grid-cols-[repeat(auto-fill,minmax(420px,1fr))] gap-4">
              {sessionId === null
                ? null
                : runs.map((run) => (
                    <RunCard
                      key={run.runId}
                      sessionId={sessionId}
                      run={run}
                      now={now}
                      stopping={stopping(run)}
                      send={sendSessionFrame}
                      onOpen={() => openRun(sessionId, run.runId)}
                    />
                  ))}
            </div>
            <span className="pt-3 text-[9px] text-doom-faint">
              click a card for the run detail · stop asks the runtime · clear hides a finished run · finished runs leave
              the grid after 10m
            </span>
          </>
        )}
      </div>
      {shownRun && sessionId !== null ? (
        <RunDrawer
          sessionId={sessionId}
          run={shownRun}
          now={now}
          stopping={stopping(shownRun)}
          send={sendSessionFrame}
          renderSlot={renderSlot}
          onClose={() => openRun(sessionId, undefined)}
        />
      ) : null}
    </div>
  );
}
