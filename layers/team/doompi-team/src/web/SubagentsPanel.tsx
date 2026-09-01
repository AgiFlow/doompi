import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  KebabIcon,
  Kbd,
  Panel,
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  STATUS_EDGE,
  StatusBadge,
} from '@agimon-ai/doompi-web-components';
import type { SessionFrameSender, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from 'react';
import type { SubagentRun } from '../types/webSubagents.ts';
import { AgentCatalogDrawer } from './AgentCatalogDrawer.tsx';
import { agentThreadTab } from './AgentThreadPanel.tsx';
import { catalog, closeCatalog, closeLaunch, openCatalog, openLaunch } from './catalogStore.ts';
import { abbreviateCwd } from './format.ts';
import { LaunchAgentDialog } from './LaunchAgentDialog.tsx';
import { RUN_ACTIONS_SLOT } from './runActionsSlot.ts';
import { elapsedRun, RUN_BADGE, RunControl } from './RunControl.tsx';
import {
  clearAutoOpen,
  dismissRun,
  isTerminalRun,
  openRun,
  requestRunStop,
  subagents,
  visibleRuns,
} from './subagentsStore.ts';

const TICK_MS = 10_000;

/**
 * How much of a run's own conversation a card carries: enough to read what it
 * is doing right now, not enough to read the run. The whole thread is one
 * click away in the run's tab.
 */
const CARD_THREAD_ENTRIES = 8;

/** The card's work line: a task binding wins; otherwise the delegation prompt. */
function WorkLine({ run }: { run: SubagentRun }) {
  const firstLine = run.task.split('\n').find((line) => line.trim() !== '') ?? '';
  if (run.taskRef) {
    return (
      <div className="flex items-center gap-2 px-3 pb-2.5">
        <Badge tone="violet" size="xs" className="shrink-0 rounded-[3px] bg-doom-violet/10">
          TASK {run.taskRef}
        </Badge>
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

/**
 * Everything a card can do, behind one control.
 *
 * A card already spends its width on the run's own stream, and stop, clear,
 * detail and the run's tab are four verbs: as buttons they crowd the footer
 * and each one has to defend itself from the card's own click.
 */
function RunMenu({
  sessionId,
  run,
  stopping,
  send,
  onOpenThread,
  onOpenDetail,
}: {
  sessionId: string;
  run: SubagentRun;
  stopping: boolean;
  send: SessionFrameSender;
  onOpenThread: () => void;
  onOpenDetail: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-testid={`run-menu-${run.runId}`}
          title="what this run can do"
          aria-label="run actions"
          onClick={(event) => event.stopPropagation()}
        >
          <KebabIcon className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-testid={`run-menu-content-${run.runId}`}>
        <DropdownMenuItem data-testid={`run-open-${run.runId}`} onSelect={onOpenThread}>
          open thread
        </DropdownMenuItem>
        <DropdownMenuItem data-testid={`run-detail-${run.runId}`} onSelect={onOpenDetail}>
          details
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {isTerminalRun(run) ? (
          <DropdownMenuItem data-testid={`run-clear-${run.runId}`} onSelect={() => dismissRun(sessionId, run.runId)}>
            clear from the grid
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            variant="destructive"
            data-testid={`run-stop-${run.runId}`}
            data-stopping={stopping}
            disabled={stopping}
            onSelect={() => requestRunStop(send, sessionId, run.runId)}
          >
            {stopping ? 'stopping…' : 'stop'}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One run in the grid: its live conversation under a header, on the host's own
 * transcript so a tool call reads the same here as in the session.
 *
 * The body is a glance, so it takes the newest entries only and does not take
 * the pointer: the whole card is the way into the run's tab.
 */
function RunCard({
  sessionId,
  run,
  now,
  stopping,
  send,
  renderThread,
  onOpenThread,
  onOpenDetail,
}: {
  sessionId: string;
  run: SubagentRun;
  now: number;
  stopping: boolean;
  send: SessionFrameSender;
  renderThread: WebPluginSlotProps['renderThread'];
  onOpenThread: () => void;
  onOpenDetail: () => void;
}) {
  const badge = RUN_BADGE[run.state];
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenThread();
    }
  };
  // A div rather than a button: the card carries a menu of its own, and a
  // button cannot contain another.
  return (
    <Panel
      asChild
      className={cn(
        'flex h-[280px] min-w-0 flex-col text-left transition-colors outline-none hover:border-doom-blue/50 focus-within:border-doom-blue',
        STATUS_EDGE[badge.tone],
      )}
    >
      <div data-testid={`run-card-${run.runId}`} data-run-state={run.state}>
        <div
          role="button"
          tabIndex={0}
          data-testid={`run-open-card-${run.runId}`}
          className="flex min-h-0 flex-1 cursor-pointer flex-col outline-none"
          title="open this run's own thread in a tab"
          onClick={onOpenThread}
          onKeyDown={onKeyDown}
        >
          <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
            <span data-testid="run-agent" className="truncate text-[12px] font-bold text-doom-hi">
              {run.agent}
            </span>
            <span className="min-w-0 flex-1" />
            <span className="shrink-0 text-[9px] text-doom-faint">{elapsedRun(run, now)}</span>
            <StatusBadge tone={badge.tone} data-testid="run-state">
              {badge.label}
            </StatusBadge>
          </div>
          <WorkLine run={run} />
          {/* The run's own journal, drawn by the host's timeline: the newest
              entries only, and inert, so the card stays one click. */}
          <div
            data-testid="run-stream"
            className="pointer-events-none flex min-h-0 flex-1 flex-col overflow-hidden border-t border-doom-border-soft bg-doom-deep"
          >
            {renderThread(run.runId, { limit: CARD_THREAD_ENTRIES, compact: true })}
          </div>
          {run.state === 'failed' && run.error ? (
            <span
              data-testid="run-error"
              className="truncate border-t border-doom-border-soft px-3 py-1.5 text-[10px] text-doom-red"
            >
              {run.error}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-doom-border-soft px-3 py-1.5">
          <span className="truncate text-[9px] text-doom-faint">
            {run.toolCount !== undefined ? `${run.toolCount} tools` : '—'}
            {run.tokens !== undefined ? ` · ${run.tokens.toLocaleString()} tk` : ''}
            {run.model ? ` · ${run.model.split('/').pop() ?? run.model}` : ''}
          </span>
          <span className="min-w-0 flex-1" />
          <RunMenu
            sessionId={sessionId}
            run={run}
            stopping={stopping}
            send={send}
            onOpenThread={onOpenThread}
            onOpenDetail={onOpenDetail}
          />
        </div>
      </div>
    </Panel>
  );
}

function SheetRow({ label, value, tone = 'text-doom-dim' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="w-11 shrink-0 text-[9px] text-doom-faint">{label}</span>
      <span className={`min-w-0 break-words text-[10px] ${tone}`}>{value}</span>
    </div>
  );
}

function SheetBlock({ label, text, testId, tone }: { label: string; text: string; testId: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-doom-border bg-doom-deep px-3 py-2.5">
      <span className="text-[8px] font-bold tracking-[0.14em] text-doom-faint">{label}</span>
      <pre
        data-testid={testId}
        className={`overflow-x-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed ${tone ?? 'text-doom-text'}`}
      >
        {text}
      </pre>
    </div>
  );
}

/**
 * What the run was asked to do and what it was given to do it with, over the
 * grid rather than beside it: the conversation is on the card and in the run's
 * tab, so this reads as a definition and takes no width from the fleet.
 */
function RunDetailSheet({
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
  const badge = RUN_BADGE[run.state];
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent data-testid="run-sheet" aria-describedby={undefined}>
        <SheetHeader closeLabel="close the run detail">
          <SheetTitle data-testid="sheet-agent">{run.agent}</SheetTitle>
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          <span className="min-w-0 flex-1" />
          <span className="text-[10px] text-doom-faint">{elapsedRun(run, now)}</span>
          {renderSlot(RUN_ACTIONS_SLOT.slot)}
          <RunControl sessionId={sessionId} run={run} stopping={stopping} send={send} />
        </SheetHeader>
        <SheetBody>
          <div className="flex flex-col gap-1.5">
            <SheetRow label="run" value={run.runId} />
            {run.taskRef ? <SheetRow label="task" value={run.taskRef} tone="text-doom-violet" /> : null}
            <SheetRow label="model" value={run.model ?? 'the runtime default'} />
            <SheetRow label="cwd" value={abbreviateCwd(run.cwd)} />
            <SheetRow
              label="work"
              value={`${run.toolCount === undefined ? 'no' : String(run.toolCount)} tools${
                run.tokens === undefined ? '' : ` · ${run.tokens.toLocaleString()} tk`
              }`}
            />
          </div>
          <SheetBlock
            label="PROMPT FROM THE MAIN AGENT"
            testId="sheet-task"
            text={run.task || '(no prompt recorded)'}
          />
          {run.summary ? <SheetBlock label="REPORT" testId="sheet-summary" text={run.summary} /> : null}
          {run.error ? <SheetBlock label="FAILURE" testId="sheet-error" text={run.error} tone="text-doom-red" /> : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The subagents tab: the focused session's fleet as a computed grid.
 *
 * Columns come from the available width (auto-fill over a 420px minimum), and
 * every card is the same height with the run's own live conversation
 * absorbing the slack, so the grid reads as a fleet rather than a ragged list.
 * A card opens the run's tab; its menu opens the detail sheet over the grid.
 * The catalog to launch from still takes the right rail, because picking an
 * agent is a list beside the fleet rather than a thing about one run.
 */
export function SubagentsPanel({
  sessionId,
  sendSessionFrame,
  renderSlot,
  renderThread,
  openTransientTab,
}: WebPluginSlotProps) {
  const runs = useStore(subagents.store, (state) => visibleRuns(subagents.select(state, sessionId)));
  const { openRunId, stopRequested, autoOpenRunId } = useStore(subagents.store, (state) =>
    subagents.select(state, sessionId),
  );
  const shelf = useStore(catalog.store, (state) => catalog.select(state, sessionId));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (autoOpenRunId === undefined || sessionId === null) return;
    const run = runs.find((candidate) => candidate.runId === autoOpenRunId);
    if (run) openTransientTab(agentThreadTab(run));
    clearAutoOpen(sessionId);
  }, [autoOpenRunId, runs, sessionId, openTransientTab]);

  const shownRun = openRunId === undefined ? undefined : runs.find((run) => run.runId === openRunId);
  const launching =
    shelf.launch === undefined ? undefined : shelf.agents.find((agent) => agent.name === shelf.launch?.agent);
  const stopping = (run: SubagentRun): boolean => stopRequested.includes(run.runId);
  const runningTally = runs.filter((run) => run.state === 'running' || run.state === 'queued').length;
  const doneTally = runs.filter((run) => run.state === 'done').length;
  const failedTally = runs.filter((run) => run.state === 'failed' || run.state === 'stopped').length;

  const showCatalog = (): void => {
    if (sessionId === null) return;
    openRun(sessionId, undefined);
    openCatalog(sessionId);
  };

  return (
    <div data-testid="subagents-panel" className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-3 py-3 sm:px-[26px] sm:py-[18px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-3">
          <span className="text-[9px] font-bold tracking-[0.18em] text-doom-faint">SUBAGENTS · this session</span>
          <span className="hidden min-w-0 flex-1 sm:block" />
          <span
            data-testid="subagents-tally"
            className="order-3 w-full text-[9px] text-doom-faint sm:order-none sm:w-auto"
          >
            {runs.length === 0 ? 'no runs yet' : `${runningTally} running · ${doneTally} done · ${failedTally} failed`}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto sm:ml-0"
            data-testid="subagents-launch"
            title="pick an agent from the catalog and launch it"
            onClick={showCatalog}
          >
            launch agent <Kbd>a l</Kbd>
          </Button>
        </div>
        {runs.length === 0 ? (
          <EmptyState
            data-testid="subagents-empty"
            title="no subagent runs yet"
            description="pick an agent from the catalog to launch one yourself, or let the main agent delegate with its subagent tool."
          />
        ) : (
          <>
            <div
              data-testid="subagents-grid"
              className="grid grid-cols-[repeat(auto-fill,minmax(min(420px,100%),1fr))] gap-4"
            >
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
                      renderThread={renderThread}
                      onOpenThread={() => {
                        closeCatalog(sessionId);
                        openTransientTab(agentThreadTab(run));
                      }}
                      onOpenDetail={() => {
                        closeCatalog(sessionId);
                        openRun(sessionId, run.runId);
                      }}
                    />
                  ))}
            </div>
            <span className="pt-3 text-[9px] text-doom-faint">
              click a card to open the run's thread · the card menu holds details, stop and clear · finished runs leave
              the grid after 10m
            </span>
          </>
        )}
      </div>
      {sessionId !== null && shelf.open ? (
        <AgentCatalogDrawer
          sessionId={sessionId}
          onClose={() => closeCatalog(sessionId)}
          onLaunch={(agent, fork) => openLaunch(sessionId, agent.name, fork)}
        />
      ) : null}
      {shownRun && sessionId !== null ? (
        <RunDetailSheet
          sessionId={sessionId}
          run={shownRun}
          now={now}
          stopping={stopping(shownRun)}
          send={sendSessionFrame}
          renderSlot={renderSlot}
          onClose={() => openRun(sessionId, undefined)}
        />
      ) : null}
      {sessionId !== null && launching !== undefined && shelf.launch !== undefined ? (
        <LaunchAgentDialog
          key={launching.name}
          sessionId={sessionId}
          agent={launching}
          cwd={shelf.cwd}
          models={shelf.models}
          fork={shelf.launch.fork}
          send={sendSessionFrame}
          onClose={() => closeLaunch(sessionId)}
          onLaunched={() => closeCatalog(sessionId)}
        />
      ) : null}
    </div>
  );
}
