import {
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
  OptionLabel,
  OptionRow,
  Popover,
  PopoverContent,
  PopoverFooter,
  PopoverHeader,
  PopoverTrigger,
  SearchIcon,
  SectionLabel,
} from '@agimon-ai/doompi-web-components';
import { useMemo, useState } from 'react';

import type {
  WorkflowJobView,
  WorkflowProgressState,
  WorkflowRunView,
  WorkflowStepView,
} from '../../../../../types/webWorkflows';
import { formatRunDuration } from '../_lib/runDuration';
import { deleteWorkflowRun, stopWorkflowRun } from '../_lib/terminalApi';
import { workflowRunIdentity } from '../_lib/workflowActivity';

export const STATE_ICON: Readonly<Record<WorkflowProgressState, { glyph: string; className: string }>> = {
  running: { glyph: '●', className: 'text-doom-blue' },
  resumed: { glyph: '●', className: 'text-doom-blue' },
  completed: { glyph: '✓', className: 'text-doom-green' },
  failed: { glyph: '✕', className: 'text-doom-red' },
  skipped: { glyph: '↷', className: 'text-doom-faint' },
  pause_requested: { glyph: '!', className: 'text-doom-yellow' },
  paused: { glyph: '!', className: 'text-doom-yellow' },
};

export const ACTIVE_STATES: ReadonlySet<WorkflowProgressState> = new Set([
  'running',
  'resumed',
  'pause_requested',
  'paused',
]);

export function spanDuration(
  startedAt: string | undefined,
  endedAt: string | undefined,
  now: number,
): string | undefined {
  if (startedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return undefined;
  const end = endedAt === undefined ? now : Date.parse(endedAt);
  if (!Number.isFinite(end)) return undefined;
  return formatRunDuration(Math.max(0, end - start));
}

export interface RunAttention {
  kind: 'error' | 'paused' | 'stale';
  text: string;
}

export function attentionFor(run: WorkflowRunView): RunAttention | undefined {
  if (run.stage === 'error') {
    const cause = run.errorMessage ?? 'the run ended in the error stage';
    return { kind: 'error', text: run.failedJob === undefined ? cause : `job '${run.failedJob}' failed: ${cause}` };
  }
  if (run.stale === true) {
    return { kind: 'stale', text: run.staleReason ?? 'the process that ran this workflow is gone' };
  }
  if (run.executionState === 'paused' || run.executionState === 'pause_requested') {
    return { kind: 'paused', text: 'the run is paused and will not move until it is resumed' };
  }
  return undefined;
}

export function runDot(run: WorkflowRunView): DotTone {
  if (run.stage === 'error') return 'red';
  if (run.executionState === 'paused' || run.executionState === 'pause_requested') return 'yellow';
  if (run.stage === 'running') return 'blue';
  if (run.outcome === 'success') return 'green';
  return 'neutral';
}

export function runState(run: WorkflowRunView): string {
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

export function WorkflowPicker({
  runs,
  selected,
  onSelect,
  className,
}: {
  runs: WorkflowRunView[];
  selected: WorkflowRunView;
  onSelect: (run: WorkflowRunView) => void;
  className?: string;
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
          className={cn('h-8 w-full max-w-[360px] justify-start border-doom-border bg-doom-deep px-2.5', className)}
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

export function JobRow({
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

export function StepRow({
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
        {step.group === undefined ? null : (
          // Steps of one group run side by side; the group names them together.
          <span data-testid={`step-group-${step.name}`} className="max-w-24 shrink-0 truncate text-2xs text-doom-faint">
            ∥ {step.group}
          </span>
        )}
        <span className="shrink-0 text-2xs text-doom-faint">
          {spanDuration(step.startedAt, step.endedAt, now) ?? ''}
        </span>
      </span>
      {step.reason === undefined ? null : (
        <span
          data-testid={`step-reason-${step.name}`}
          title={step.reason}
          className={cn('truncate pl-5 text-2xs', step.status === 'failed' ? 'text-doom-red' : 'text-doom-faint')}
        >
          {step.reason}
        </span>
      )}
    </button>
  );
}

export function DeleteWorkflowDialog({
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
export function StopWorkflowButton({ run, sessionId }: { run: WorkflowRunView; sessionId: string | null }) {
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
