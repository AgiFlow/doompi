import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import {
  AnsiLine,
  Button,
  ChevronDownIcon,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Dot,
  type DotTone,
  EmptyState,
  Input,
  Kbd,
  OptionLabel,
  OptionRow,
  Popover,
  PopoverContent,
  PopoverFooter,
  PopoverHeader,
  PopoverTrigger,
  SearchIcon,
  SectionLabel,
  StatusBadge,
  StreamCursor,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import type {
  WorkflowJobView,
  WorkflowProgressState,
  WorkflowRunView,
  WorkflowStepView,
} from '../../../../../types/webWorkflows';
import type { WorkflowTerminalCapabilitiesView } from '../../../../../types/webWorkflowTerminal';
import { catalog, closeCatalog, closeLaunch, openCatalog, openLaunch } from '../_lib/catalogStore';
import { formatRunDuration } from '../_lib/runDuration';
import { deleteWorkflowRun, followScreen, stopWorkflowRun } from '../_lib/terminalApi';
import { workflowRunIdentity } from '../_lib/workflowActivity';
import { focusRun, removeRun, workflows } from '../_lib/workflowsStore';
import { ArtifactsPane, artifactTab } from './ArtifactsPane';
import { LaunchWorkflowDialog } from './LaunchWorkflowDialog';
import { StepSteerComposer } from './StepSteerComposer';
import { stepSessionRef, stepTerminalTab } from './StepTerminalPanel';
import { WorkflowCatalogDrawer } from './WorkflowCatalogDrawer';

/** One workflows tab per session; the surface is singular, so the id needs nothing else. */
export const WORKFLOWS_TAB_ID = 'workflows-runs';

const TICK_MS = 10_000;

const STATE_ICON: Readonly<Record<WorkflowProgressState, { glyph: string; className: string }>> = {
  running: { glyph: '●', className: 'text-doom-blue' },
  resumed: { glyph: '●', className: 'text-doom-blue' },
  completed: { glyph: '✓', className: 'text-doom-green' },
  failed: { glyph: '✕', className: 'text-doom-red' },
  skipped: { glyph: '↷', className: 'text-doom-faint' },
  pause_requested: { glyph: '!', className: 'text-doom-yellow' },
  paused: { glyph: '!', className: 'text-doom-yellow' },
};

const ACTIVE_STATES: ReadonlySet<WorkflowProgressState> = new Set(['running', 'resumed', 'pause_requested', 'paused']);

function spanDuration(startedAt: string | undefined, endedAt: string | undefined, now: number): string | undefined {
  if (startedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return undefined;
  const end = endedAt === undefined ? now : Date.parse(endedAt);
  if (!Number.isFinite(end)) return undefined;
  return formatRunDuration(Math.max(0, end - start));
}

function attentionFor(run: WorkflowRunView): { kind: 'error' | 'paused'; text: string } | undefined {
  if (run.stage === 'error') {
    const cause = run.errorMessage ?? 'the run ended in the error stage';
    return { kind: 'error', text: run.failedJob === undefined ? cause : `job '${run.failedJob}' failed: ${cause}` };
  }
  if (run.executionState === 'paused' || run.executionState === 'pause_requested') {
    return { kind: 'paused', text: 'the run is paused and will not move until it is resumed' };
  }
  return undefined;
}

function runDot(run: WorkflowRunView): DotTone {
  if (run.stage === 'error') return 'red';
  if (run.executionState === 'paused' || run.executionState === 'pause_requested') return 'yellow';
  if (run.stage === 'running') return 'blue';
  if (run.outcome === 'success') return 'green';
  return 'neutral';
}

function runState(run: WorkflowRunView): string {
  if (run.stage === 'error') return 'failed';
  if (run.executionState === 'paused' || run.executionState === 'pause_requested') return 'paused';
  if (run.stage === 'running') return 'running';
  return run.outcome ?? run.stage;
}

/** The statuses the picker filters by, in the order its status row lists them. */
const RUN_FILTERS = ['all', 'running', 'paused', 'failed', 'done'] as const;
type RunFilter = (typeof RUN_FILTERS)[number];

function runFilterOf(run: WorkflowRunView): Exclude<RunFilter, 'all'> {
  if (run.stage === 'error') return 'failed';
  if (run.executionState === 'paused' || run.executionState === 'pause_requested') return 'paused';
  if (run.stage === 'running') return 'running';
  return 'done';
}

function runPriority(run: WorkflowRunView): number {
  if (attentionFor(run) !== undefined) return 0;
  if (run.stage === 'running') return 1;
  return 2;
}

function runSearchText(run: WorkflowRunView): string {
  return [
    run.displayName,
    run.workflowName,
    run.stage,
    run.outcome,
    run.executionState,
    run.position?.job,
    run.position?.step,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}

function WorkflowPicker({
  runs,
  selected,
  onSelect,
}: {
  runs: WorkflowRunView[];
  selected: WorkflowRunView;
  onSelect: (run: WorkflowRunView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RunFilter>('all');
  const ordered = useMemo(() => [...runs].sort((left, right) => runPriority(left) - runPriority(right)), [runs]);
  const needle = query.trim().toLowerCase();
  const shown = ordered.filter(
    (run) => (filter === 'all' || runFilterOf(run) === filter) && runSearchText(run).includes(needle),
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="workflow-picker"
          className="h-8 w-full max-w-[360px] justify-start border-doom-border bg-doom-deep px-2.5"
        >
          <SearchIcon className="h-3 w-3 shrink-0 text-doom-faint" />
          <span className="min-w-0 flex-1 truncate text-left font-bold text-doom-hi">{selected.displayName}</span>
          <span className="shrink-0 text-2xs font-normal text-doom-faint">{runs.length} workflows</span>
          <ChevronDownIcon className="h-3 w-3 shrink-0 text-doom-dim" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        data-testid="workflow-picker-popover"
        className="w-[440px] border-doom-edge-blue"
      >
        <PopoverHeader>
          <SectionLabel className="tracking-wide text-doom-blue">workflow</SectionLabel>
          <span className="truncate text-2xs text-doom-faint">{selected.displayName}</span>
        </PopoverHeader>
        <div className="border-b border-doom-border-soft p-1.5">
          <Input
            autoFocus
            data-testid="workflow-picker-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="filter workflows…"
            className="w-full px-2 py-1 text-sm"
          />
        </div>
        <div
          role="listbox"
          aria-label="workflows"
          className="flex max-h-[300px] flex-col gap-0.5 overflow-y-auto p-1.5"
        >
          {shown.length === 0 ? <EmptyState className="py-4" title="no workflow matches" /> : null}
          {shown.map((run) => {
            const active = workflowRunIdentity(run) === workflowRunIdentity(selected);
            return (
              <OptionRow
                key={workflowRunIdentity(run)}
                density="compact"
                active={active}
                data-testid={`workflow-option-${run.runKey}`}
                data-run-stage={run.stage}
                data-active={active}
                onClick={() => {
                  onSelect(run);
                  setOpen(false);
                }}
                className={cn(
                  'w-full gap-2.5 py-1.5 transition-colors hover:bg-doom-deep focus-visible:bg-doom-deep',
                  active && 'bg-doom-tint-blue hover:brightness-125',
                )}
              >
                <span className="w-14 shrink-0 truncate text-2xs text-doom-faint">{runState(run)}</span>
                <OptionLabel density="compact" className={active ? 'text-doom-blue' : 'text-doom-hi'}>
                  {run.displayName}
                </OptionLabel>
                <span className="max-w-[40%] truncate text-2xs text-doom-faint">
                  {[run.position?.job, run.position?.step].filter(Boolean).join(' · ')}
                </span>
                <Dot tone={runDot(run)} pulse={run.stage === 'running'} />
              </OptionRow>
            );
          })}
        </div>
        <PopoverFooter className="flex-wrap justify-start gap-1 py-1.5">
          <SectionLabel className="mr-1 tracking-wide">status</SectionLabel>
          {RUN_FILTERS.map((candidate) => {
            const current = filter === candidate;
            return (
              <Button
                key={candidate}
                variant="ghost"
                size="xs"
                data-testid={`workflow-filter-${candidate}`}
                data-current={current}
                onClick={() => setFilter(candidate)}
                className={cn('text-xs', current && 'bg-doom-blue/25 font-bold text-doom-blue hover:bg-doom-blue/25')}
              >
                {candidate}
              </Button>
            );
          })}
        </PopoverFooter>
      </PopoverContent>
    </Popover>
  );
}

function SelectedAttention({ run }: { run: WorkflowRunView }) {
  const attention = attentionFor(run);
  if (attention === undefined) return null;
  return (
    <div
      data-testid="workflow-needs-you"
      className={cn(
        'flex items-center gap-2 rounded border px-3 py-2',
        attention.kind === 'error'
          ? 'border-doom-edge-red bg-doom-tint-red/40'
          : 'border-doom-edge-yellow bg-doom-tint-yellow/40',
      )}
    >
      <StatusBadge size="xs" tone={attention.kind === 'error' ? 'error' : 'running'}>
        {attention.kind === 'error' ? 'ERROR' : 'PAUSED'}
      </StatusBadge>
      <span data-testid={`needs-card-${run.runKey}`} className="min-w-0 flex-1 truncate text-xs text-doom-text">
        {run.displayName}: {attention.text}
      </span>
      <span className="shrink-0 text-2xs text-doom-faint">
        {attention.kind === 'error' ? 'recover from the owning session' : 'resume from the owning session'}
      </span>
    </div>
  );
}

function JobRow({
  job,
  now,
  selected,
  onSelect,
}: {
  job: WorkflowJobView;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const icon = STATE_ICON[job.status];
  return (
    <OptionRow
      density="compact"
      active={selected}
      data-testid={`job-row-${job.name}`}
      data-job-status={job.status}
      onClick={onSelect}
      className={cn('gap-2 rounded px-2 py-1.5', !selected && 'hover:bg-doom-deep')}
    >
      <span className={`w-3 shrink-0 text-xs ${icon.className}`}>{icon.glyph}</span>
      <OptionLabel density="compact" className={cn('text-xs', selected ? 'text-doom-hi' : 'text-doom-text')}>
        {job.name}
      </OptionLabel>
      <span className="shrink-0 text-2xs text-doom-faint">{spanDuration(job.startedAt, job.endedAt, now) ?? ''}</span>
    </OptionRow>
  );
}

function StepRow({
  step,
  now,
  selected,
  onSelect,
}: {
  step: WorkflowStepView;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const icon = STATE_ICON[step.status];
  return (
    <button
      type="button"
      data-testid={`step-row-${step.name}`}
      data-step-status={step.status}
      data-active={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-doom-deep',
        selected && 'bg-doom-tint-blue ring-1 ring-inset ring-doom-blue/40',
      )}
    >
      <span className="flex items-center gap-2">
        <span className={`w-3 shrink-0 text-xs ${icon.className}`}>{icon.glyph}</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-2xs',
            step.status === 'failed' ? 'text-doom-red' : 'text-doom-text',
          )}
        >
          {step.name}
        </span>
        <span className="shrink-0 text-2xs text-doom-faint">
          {spanDuration(step.startedAt, step.endedAt, now) ?? ''}
        </span>
      </span>
      {step.reason === undefined ? null : (
        <span className={cn('truncate pl-5 text-2xs', step.status === 'failed' ? 'text-doom-red' : 'text-doom-faint')}>
          {step.reason}
        </span>
      )}
    </button>
  );
}

function ScreenLine({ line }: { line: string }) {
  // A blank row still has to hold the grid open, so an empty line keeps its
  // height rather than collapsing the screen by one row.
  if (line.length === 0) return <span className="block h-[15px]" />;
  return <AnsiLine line={line} className="block whitespace-pre" />;
}

interface InlineStepOutputProps {
  run: WorkflowRunView;
  job: WorkflowJobView;
  step: WorkflowStepView | undefined;
  sessionId: string | null;
  onOpenTerminal: () => void;
  renderSessionTranscript: WebPluginSlotProps['renderSessionTranscript'];
}

/** A step's output: its agent conversation when it ran as a session, else the run's terminal. */
function InlineStepOutput(props: InlineStepOutputProps) {
  const { run, job, step, sessionId, onOpenTerminal, renderSessionTranscript } = props;
  const sessionRef = stepSessionRef(run, {
    workspace: run.workspace,
    runKey: run.runKey,
    job: job.name,
    step: step?.name,
  });
  if (sessionRef === undefined || renderSessionTranscript === undefined) return <InlineTerminalOutput {...props} />;
  const live = step?.status === 'running';
  return (
    <div data-testid="workflow-inline-conversation" className="flex min-h-0 flex-1 flex-col bg-doom-deep">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-doom-border-soft px-3">
        <Dot tone={live ? 'blue' : 'neutral'} pulse={live} />
        <span className={cn('text-2xs font-bold', live ? 'text-doom-blue' : 'text-doom-faint')}>AGENT SESSION</span>
        <span className="min-w-0 truncate text-xs font-bold text-doom-hi">{step?.name ?? job.name}</span>
        <span className="min-w-0 flex-1" />
        <Button variant="outline" size="xs" data-testid="workflow-open-conversation" onClick={onOpenTerminal}>
          open conversation
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">{renderSessionTranscript(sessionRef.id)}</div>
      {live ? <StepSteerComposer key={sessionRef.id} run={run} sessionId={sessionId} /> : null}
    </div>
  );
}

function InlineTerminalOutput({ run, job, step, sessionId, onOpenTerminal }: InlineStepOutputProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<WorkflowTerminalCapabilitiesView>();
  const [ended, setEnded] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Clearing the mirror of the previous run before subscribing to the new one; the
    // screen subscription below is the external system.
    // oxlint-disable-next-line react/set-state-in-effect
    setLines([]);
    setCapabilities(undefined);
    setEnded(false);
    return followScreen(
      run.workspace,
      run.runKey,
      (event) => {
        setLines(event.lines);
        setCapabilities(event.capabilities);
        if (event.ended === true) setEnded(true);
      },
      sessionId,
    );
  }, [run.workspace, run.runKey, sessionId]);

  useEffect(() => {
    screenRef.current?.scrollTo({ top: screenRef.current.scrollHeight });
  }, [lines]);

  return (
    <div data-testid="workflow-inline-output" className="flex min-h-0 flex-1 flex-col bg-doom-deep">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-doom-border-soft px-3">
        <Dot tone={ended ? 'neutral' : 'blue'} pulse={!ended && run.stage === 'running'} />
        <span className={cn('text-2xs font-bold', ended ? 'text-doom-faint' : 'text-doom-blue')}>
          {ended ? 'FINAL OUTPUT' : 'LIVE OUTPUT'}
        </span>
        <span className="min-w-0 truncate text-xs font-bold text-doom-hi">{step?.name ?? job.name}</span>
        <span className="min-w-0 flex-1" />
        <span className="text-2xs text-doom-faint">{ended ? 'settled' : 'following · 500ms'}</span>
        <Button variant="outline" size="xs" data-testid="workflow-open-terminal" onClick={onOpenTerminal}>
          open terminal
        </Button>
      </div>
      <div
        ref={screenRef}
        data-testid="workflow-inline-screen"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-sm leading-tight text-doom-text"
      >
        {lines.length === 0 ? (
          <span className="text-xs text-doom-faint">
            {capabilities?.readable === false
              ? (capabilities.reason ?? 'This run has no terminal to read.')
              : 'waiting for the run to paint…'}
          </span>
        ) : (
          lines.map((line, index) => <ScreenLine key={index} line={line} />)
        )}
        {!ended && run.stage === 'running' ? <StreamCursor className="mt-0.5 h-[12px] w-1.5" /> : null}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-doom-border-soft px-3 text-2xs text-doom-faint">
        <span>output follows automatically · select another step to inspect its current screen</span>
        <span className="min-w-0 flex-1" />
        <span>last 48 lines</span>
      </div>
    </div>
  );
}

function DeleteWorkflowDialog({
  run,
  sessionId,
  onClose,
  onDeleted,
}: {
  run: WorkflowRunView;
  sessionId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  const confirm = (): void => {
    setDeleting(true);
    setError(undefined);
    void deleteWorkflowRun(run.workspace, run.runKey, sessionId).then((result) => {
      if ('error' in result) {
        setDeleting(false);
        setError(result.error);
        return;
      }
      onDeleted();
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onClose();
      }}
    >
      <DialogContent width="md" data-testid="delete-workflow-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Delete {run.displayName}?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm leading-relaxed text-doom-dim">
            This permanently removes the workflow run, including its logs and artifacts. This action cannot be undone.
          </p>
          {error === undefined ? null : (
            <p data-testid="delete-workflow-error" className="text-xs text-doom-red">
              {error}
            </p>
          )}
          <DialogFooter>
            <span className="min-w-0 flex-1" />
            <Button
              variant="outline"
              size="xs"
              data-testid="delete-workflow-cancel"
              disabled={deleting}
              onClick={onClose}
            >
              cancel
            </Button>
            <Button
              variant="danger"
              size="xs"
              data-testid="delete-workflow-confirm"
              loading={deleting}
              loadingLabel="deleting workflow"
              onClick={confirm}
            >
              delete permanently
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Ends a running workflow; the button holds its busy state until the run settles and it unmounts. */
function StopWorkflowButton({ run, sessionId }: { run: WorkflowRunView; sessionId: string | null }) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();

  const stop = (): void => {
    setStopping(true);
    setError(undefined);
    void stopWorkflowRun(run.workspace, run.runKey, sessionId).then((result) => {
      if (!('error' in result)) return;
      setStopping(false);
      setError(result.error);
    });
  };

  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-doom-border-soft p-1.5">
      {error === undefined ? null : (
        <span data-testid="stop-workflow-error" className="px-1 text-2xs text-doom-red">
          {error}
        </span>
      )}
      <Button
        variant="danger-outline"
        size="xs"
        data-testid="stop-workflow"
        loading={stopping}
        loadingLabel="stopping workflow"
        onClick={stop}
        className="w-full"
      >
        stop workflow
      </Button>
    </div>
  );
}

function DetailPane({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-doom-border">
      {children}
    </div>
  );
}

/** The canonical workflow surface: a scalable picker, compact step navigation, and one dominant detail pane. */
export function WorkflowsPanel({
  sessionId,
  openTransientTab,
  sendSessionFrame,
  renderSessionTranscript,
}: WebPluginSlotProps) {
  const runs = useStore(workflows.store, (state) => workflows.select(state, sessionId).runs);
  const selectedRun = useStore(workflows.store, (state) => workflows.select(state, sessionId).focusedRun);
  const catalogState = useStore(catalog.store, (state) => catalog.select(state, sessionId));
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [pane, setPane] = useState<'output' | 'artifacts'>('output');
  const [deletingRun, setDeletingRun] = useState<WorkflowRunView>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const run = runs.find((candidate) => workflowRunIdentity(candidate) === selectedRun) ?? runs[0];
  const jobs = run?.jobs ?? [];
  const fallbackJob =
    run?.position?.job ?? jobs.find((candidate) => ACTIVE_STATES.has(candidate.status))?.name ?? jobs.at(-1)?.name;
  const job =
    jobs.find((candidate) => candidate.name === selectedJob) ??
    jobs.find((candidate) => candidate.name === fallbackJob);
  const fallbackStep =
    run?.position?.job === job?.name
      ? run?.position?.step
      : (job?.steps.find((candidate) => ACTIVE_STATES.has(candidate.status))?.name ?? job?.steps.at(-1)?.name);
  const step =
    job?.steps.find((candidate) => candidate.name === selectedStep) ??
    job?.steps.find((candidate) => candidate.name === fallbackStep);
  const launching = catalogState.workflows.find((workflow) => workflow.path === catalogState.launch);

  const selectRun = (candidate: WorkflowRunView): void => {
    if (sessionId !== null) focusRun(sessionId, workflowRunIdentity(candidate));
    setSelectedJob(null);
    setSelectedStep(null);
    setPane('output');
  };

  return (
    <div data-testid="workflows-panel" className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden px-[18px] py-[14px]">
        {run === undefined ? (
          <EmptyState
            data-testid="workflows-empty"
            title="no workflow runs yet"
            description="pick one from the catalog, or launch it from the session with SPC w l, and the run shows up here live."
          >
            <Button
              variant="outline"
              size="sm"
              data-testid="workflows-open-catalog"
              onClick={() => {
                if (sessionId !== null) openCatalog(sessionId);
              }}
            >
              launch workflow <Kbd>SPC w l</Kbd>
            </Button>
          </EmptyState>
        ) : (
          <>
            <div className="flex h-[46px] shrink-0 items-center gap-2 rounded-md border border-doom-border bg-doom-panel px-2.5">
              <WorkflowPicker runs={runs} selected={run} onSelect={selectRun} />
              <span className="min-w-0 flex-1" />
              <span data-testid="workflows-tally" className="text-2xs text-doom-faint">
                {runs.filter((candidate) => candidate.stage === 'running').length} running · {runs.length} total
              </span>
              {run.stage === 'running' ? null : (
                <Button
                  variant="danger-outline"
                  size="xs"
                  data-testid="delete-workflow"
                  onClick={() => setDeletingRun(run)}
                >
                  delete
                </Button>
              )}
              <Button
                variant="outline"
                size="xs"
                data-testid="workflows-open-catalog"
                onClick={() => {
                  if (sessionId !== null) openCatalog(sessionId);
                }}
              >
                launch
              </Button>
            </div>
            <SelectedAttention run={run} />
            <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
              <div
                data-testid="jobs-pane"
                className="flex max-h-44 w-full shrink-0 flex-col overflow-hidden rounded-md border border-doom-border bg-doom-panel sm:max-h-none sm:w-[214px]"
              >
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
                  <div className="flex items-center px-2 pb-1 pt-1">
                    <span className="text-2xs font-bold tracking-wider text-doom-faint">JOBS</span>
                    <span className="min-w-0 flex-1" />
                    <span className="text-2xs text-doom-faint">
                      {jobs.filter((candidate) => candidate.status === 'completed').length}/{jobs.length}
                    </span>
                  </div>
                  {jobs.length === 0 ? (
                    <EmptyState className="py-4" title="no progress recorded yet" />
                  ) : (
                    jobs.map((candidate) => (
                      <JobRow
                        key={candidate.name}
                        job={candidate}
                        now={now}
                        selected={job !== undefined && candidate.name === job.name}
                        onSelect={() => {
                          setSelectedJob(candidate.name);
                          setSelectedStep(null);
                          setPane('output');
                        }}
                      />
                    ))
                  )}
                  {job === undefined ? null : (
                    <>
                      <div className="mx-1 my-1.5 border-t border-doom-border-soft" />
                      <div className="flex items-center px-2 pb-1">
                        <span
                          data-testid="job-pane-name"
                          className="min-w-0 flex-1 truncate text-2xs font-bold text-doom-hi"
                        >
                          {job.name}
                        </span>
                        <span className="text-2xs text-doom-faint">
                          {spanDuration(job.startedAt, job.endedAt, now) ?? ''}
                        </span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {job.steps.map((candidate) => (
                          <StepRow
                            key={candidate.name}
                            step={candidate}
                            now={now}
                            selected={step !== undefined && candidate.name === step.name}
                            onSelect={() => {
                              setSelectedStep(candidate.name);
                              setPane('output');
                            }}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>
                {run.stage === 'running' ? (
                  <StopWorkflowButton key={workflowRunIdentity(run)} run={run} sessionId={sessionId} />
                ) : null}
              </div>
              <DetailPane>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-doom-border-soft bg-doom-panel px-3">
                  <span className="min-w-0 truncate text-xs font-bold text-doom-hi">
                    {job?.name ?? run.displayName}
                  </span>
                  {job === undefined ? null : (
                    <StatusBadge className={cn('bg-doom-deep', STATE_ICON[job.status].className)}>
                      {job.status.replace('_', ' ')}
                    </StatusBadge>
                  )}
                  <Button
                    variant={pane === 'output' ? 'primary' : 'outline'}
                    size="xs"
                    data-testid="pane-tab-output"
                    data-active={pane === 'output'}
                    onClick={() => setPane('output')}
                  >
                    output
                  </Button>
                  <Button
                    variant={pane === 'artifacts' ? 'primary' : 'outline'}
                    size="xs"
                    data-testid="pane-tab-artifacts"
                    data-active={pane === 'artifacts'}
                    onClick={() => setPane('artifacts')}
                  >
                    artifacts
                  </Button>
                </div>
                {pane === 'artifacts' ? (
                  <ArtifactsPane
                    run={run}
                    sessionId={sessionId}
                    onOpen={(path) => openTransientTab(artifactTab(run, path))}
                  />
                ) : job === undefined ? (
                  <EmptyState className="py-6" title="select a job to see its output" />
                ) : (
                  <InlineStepOutput
                    run={run}
                    job={job}
                    step={step}
                    sessionId={sessionId}
                    onOpenTerminal={() => openTransientTab(stepTerminalTab(run, job.name, step?.name))}
                    renderSessionTranscript={renderSessionTranscript}
                  />
                )}
              </DetailPane>
            </div>
          </>
        )}
      </div>
      {sessionId !== null && catalogState.open ? (
        <WorkflowCatalogDrawer
          sessionId={sessionId}
          onClose={() => closeCatalog(sessionId)}
          onLaunch={(workflow) => openLaunch(sessionId, workflow.path)}
        />
      ) : null}
      {sessionId !== null && launching !== undefined ? (
        <LaunchWorkflowDialog
          sessionId={sessionId}
          workflow={launching}
          cwd={catalogState.cwd}
          initialPrompt={catalogState.prompt}
          send={sendSessionFrame}
          onClose={() => closeLaunch(sessionId)}
          onLaunched={() => {
            closeLaunch(sessionId);
            closeCatalog(sessionId);
          }}
        />
      ) : null}
      {sessionId !== null && deletingRun !== undefined ? (
        <DeleteWorkflowDialog
          run={deletingRun}
          sessionId={sessionId}
          onClose={() => setDeletingRun(undefined)}
          onDeleted={() => {
            removeRun(sessionId, workflowRunIdentity(deletingRun));
            setDeletingRun(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

/** The temporary tab the workflow surface opens in; opening it again only focuses it. */
export function workflowsTab(): TransientTab {
  return { id: WORKFLOWS_TAB_ID, label: 'workflows', panel: WorkflowsPanel };
}
