import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import {
  Button,
  ChevronDownIcon,
  ChevronRightIcon,
  cn,
  Dot,
  EmptyState,
  StatusBadge,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import type { WorkflowJobView, WorkflowRunView } from '../../../../../../types/webWorkflows';
import { ArtifactsPane, artifactTab } from '../../_components/ArtifactsPane';
import { stepTerminalTab } from '../../_components/StepTerminalPanel';
import {
  ACTIVE_STATES,
  attentionFor,
  DeleteWorkflowDialog,
  runDot,
  runState,
  spanDuration,
  STATE_ICON,
  StepRow,
  StopWorkflowButton,
  WorkflowPicker,
} from '../../_components/WorkflowRunParts';
import { openCatalog } from '../../_lib/catalogStore';
import { ownsRun, workflowRunIdentity } from '../../_lib/workflowActivity';
import { focusRun, removeRun, workflows } from '../../_lib/workflowsStore';

const TICK_MS = 10_000;

const STATE_TONE = {
  running: 'info',
  paused: 'running',
  failed: 'error',
  success: 'ok',
} as const;

function stateTone(state: string): 'info' | 'running' | 'error' | 'ok' | 'neutral' {
  return state in STATE_TONE ? STATE_TONE[state as keyof typeof STATE_TONE] : 'neutral';
}

/** The steps moving right now, across every job, so a parallel group reads as one list. */
function activeSteps(run: WorkflowRunView): { job: string; step: WorkflowJobView['steps'][number] }[] {
  return run.jobs.flatMap((job) =>
    job.steps.filter((step) => ACTIVE_STATES.has(step.status)).map((step) => ({ job: job.name, step })),
  );
}

/** A job opens by default while it is moving or failed, so the step that needs a look is already showing. */
function openByDefault(run: WorkflowRunView, job: WorkflowJobView): boolean {
  if (run.position?.job === job.name) return true;
  if (ACTIVE_STATES.has(job.status) || job.status === 'failed') return true;
  return job.steps.some((step) => ACTIVE_STATES.has(step.status) || step.status === 'failed');
}

function SectionHeading({ label, meta }: { label: string; meta?: string }) {
  return (
    <div className="flex items-center px-4 pb-1 pt-3">
      <span className="text-2xs font-bold tracking-wider text-doom-faint">{label}</span>
      <span className="min-w-0 flex-1" />
      {meta === undefined ? null : <span className="text-2xs text-doom-faint">{meta}</span>}
    </div>
  );
}

function RunHeader({
  run,
  runs,
  now,
  onSelectRun,
}: {
  run: WorkflowRunView;
  runs: WorkflowRunView[];
  now: number;
  onSelectRun: (run: WorkflowRunView) => void;
}) {
  const state = runState(run);
  const where = [run.position?.job, run.position?.step].filter(Boolean).join(' › ');
  const elapsed = spanDuration(run.startedAt, run.finishedAt, now);
  return (
    <div
      data-testid="workflow-dock-run"
      className="flex shrink-0 flex-col gap-1.5 border-b border-doom-border px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Dot tone={runDot(run)} pulse={run.stage === 'running' && state === 'running'} />
        <span title={run.displayName} className="min-w-0 flex-1 truncate text-sm font-bold text-doom-hi">
          {run.displayName}
        </span>
        <StatusBadge size="xs" tone={stateTone(state)} data-testid="workflow-dock-state" data-run-state={state}>
          {state.toUpperCase()}
        </StatusBadge>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-doom-faint">
        <span title={where} className="min-w-0 flex-1 truncate">
          {where || (run.stage === 'running' ? 'starting' : run.workflowPath)}
        </span>
        {elapsed === undefined ? null : <span className="shrink-0">{elapsed}</span>}
      </div>
      {runs.length > 1 ? (
        <WorkflowPicker runs={runs} selected={run} onSelect={onSelectRun} className="max-w-none" />
      ) : null}
    </div>
  );
}

function AttentionBanner({ run }: { run: WorkflowRunView }) {
  const attention = attentionFor(run);
  if (attention === undefined) return null;
  const paused = attention.kind === 'paused';
  return (
    <div
      data-testid="workflow-dock-attention"
      data-attention={attention.kind}
      className={cn(
        'mx-3 mt-3 flex flex-col gap-1 rounded-md border px-3 py-2',
        paused ? 'border-doom-edge-yellow bg-doom-tint-yellow/40' : 'border-doom-edge-red bg-doom-tint-red/40',
      )}
    >
      <div className="flex items-center gap-2">
        <StatusBadge size="xs" tone={paused ? 'running' : 'error'}>
          {attention.kind.toUpperCase()}
        </StatusBadge>
        <span className="min-w-0 flex-1 text-2xs text-doom-faint">
          {paused ? 'waiting to be resumed' : 'needs a look'}
        </span>
      </div>
      <span className="break-words text-xs text-doom-text">{attention.text}</span>
      <span className="text-2xs text-doom-faint">
        {paused
          ? 'ask the agent in this conversation to resume it'
          : 'ask the agent in this conversation to diagnose or recover it'}
      </span>
    </div>
  );
}

function ActiveNow({
  run,
  now,
  onOpenStep,
}: {
  run: WorkflowRunView;
  now: number;
  onOpenStep: (job: string, step: string) => void;
}) {
  const active = activeSteps(run);
  if (active.length === 0) return null;
  return (
    <section data-testid="workflow-dock-active" aria-label="active steps">
      <SectionHeading label="ACTIVE NOW" meta={String(active.length)} />
      <div className="flex flex-col gap-0.5 px-2">
        {active.map(({ job, step }) => {
          const paused = step.status === 'paused' || step.status === 'pause_requested';
          return (
            <button
              key={`${job}/${step.name}`}
              type="button"
              data-testid={`workflow-dock-active-${step.name}`}
              title={`open ${step.name}`}
              onClick={() => onOpenStep(job, step.name)}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-doom-panel"
            >
              <Dot tone={paused ? 'yellow' : 'blue'} pulse={!paused} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-bold text-doom-hi">{step.name}</span>
                <span className="truncate text-2xs text-doom-faint">
                  {job}
                  {step.group === undefined ? '' : ` · ∥ ${step.group}`}
                </span>
              </span>
              <span className="shrink-0 text-2xs text-doom-faint">
                {spanDuration(step.startedAt, step.endedAt, now) ?? ''}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function JobTree({
  run,
  now,
  onOpenStep,
}: {
  run: WorkflowRunView;
  now: number;
  onOpenStep: (job: string, step: string) => void;
}) {
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({});
  const done = run.jobs.filter((job) => job.status === 'completed' || job.status === 'skipped').length;
  return (
    <section data-testid="workflow-dock-jobs" aria-label="jobs">
      <SectionHeading label="JOBS" meta={`${done}/${run.jobs.length}`} />
      {run.jobs.length === 0 ? (
        <EmptyState className="py-3" title="no progress recorded yet" />
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {run.jobs.map((job) => {
            const open = toggled[job.name] ?? openByDefault(run, job);
            const icon = STATE_ICON[job.status];
            const finished = job.steps.filter(
              (step) => step.status === 'completed' || step.status === 'skipped',
            ).length;
            return (
              <div key={job.name} className="flex flex-col">
                <button
                  type="button"
                  data-testid={`job-row-${job.name}`}
                  data-job-status={job.status}
                  aria-expanded={open}
                  onClick={() => setToggled((current) => ({ ...current, [job.name]: !open }))}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-doom-panel"
                >
                  {open ? (
                    <ChevronDownIcon className="h-2.5 w-2.5 shrink-0 text-doom-faint" />
                  ) : (
                    <ChevronRightIcon className="h-2.5 w-2.5 shrink-0 text-doom-faint" />
                  )}
                  <span className={`w-3 shrink-0 text-xs ${icon.className}`}>{icon.glyph}</span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-xs',
                      job.status === 'failed' ? 'text-doom-red' : 'text-doom-text',
                    )}
                  >
                    {job.name}
                  </span>
                  <span className="shrink-0 text-2xs text-doom-faint">
                    {open || job.steps.length === 0
                      ? (spanDuration(job.startedAt, job.endedAt, now) ?? '')
                      : `${finished}/${job.steps.length} steps`}
                  </span>
                </button>
                {open && job.steps.length > 0 ? (
                  <div className="ml-4 flex flex-col gap-0.5 border-l border-doom-border-soft pl-1">
                    {job.steps.map((step) => (
                      <StepRow
                        key={step.name}
                        step={step}
                        now={now}
                        selected={ACTIVE_STATES.has(step.status)}
                        onSelect={() => onOpenStep(job.name, step.name)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export interface WorkflowDockViewProps {
  /** The runs this session owns; the picker shows when there is more than one. */
  runs: WorkflowRunView[];
  run: WorkflowRunView;
  now: number;
  sessionId: string | null;
  onSelectRun: (run: WorkflowRunView) => void;
  onOpenStep: (job: string, step: string) => void;
  onDeleted: () => void;
  /** The run directory listing; the panel passes the live pane, a story a fixed list. */
  artifacts: ReactNode;
}

/** One workflow run as the dock shows it: where it is, what is moving, what it produced. */
export function WorkflowDockView({
  runs,
  run,
  now,
  sessionId,
  onSelectRun,
  onOpenStep,
  onDeleted,
  artifacts,
}: WorkflowDockViewProps) {
  const [deleting, setDeleting] = useState(false);
  return (
    <div data-testid="workflow-dock" className="flex h-full min-h-0 flex-1 flex-col">
      <RunHeader run={run} runs={runs} now={now} onSelectRun={onSelectRun} />
      <div data-testid="workflow-dock-scroll" className="min-h-0 flex-1 overflow-y-auto pb-3">
        <AttentionBanner run={run} />
        <ActiveNow run={run} now={now} onOpenStep={onOpenStep} />
        <JobTree key={workflowRunIdentity(run)} run={run} now={now} onOpenStep={onOpenStep} />
        <section data-testid="workflow-dock-artifacts" aria-label="artifacts">
          <SectionHeading label="ARTIFACTS" />
          <div className="px-1">{artifacts}</div>
        </section>
      </div>
      {run.stage === 'running' ? (
        <div className="shrink-0">
          <StopWorkflowButton key={workflowRunIdentity(run)} run={run} sessionId={sessionId} />
          <p className="px-3 pb-2 text-2xs text-doom-faint">
            this session runs the workflow; removing or restarting it stops the run
          </p>
        </div>
      ) : (
        <div className="flex shrink-0 border-t border-doom-border-soft p-1.5">
          <Button
            variant="danger-outline"
            size="xs"
            data-testid="delete-workflow"
            disabled={sessionId === null}
            onClick={() => setDeleting(true)}
            className="w-full"
          >
            delete run
          </Button>
        </div>
      )}
      {sessionId !== null && deleting ? (
        <DeleteWorkflowDialog
          run={run}
          sessionId={sessionId}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            onDeleted();
          }}
        />
      ) : null}
    </div>
  );
}

/** The `workflow` dock face: the run this workflow session owns, live from the runs channel. */
export function WorkflowDockPanel({ sessionId, openTransientTab }: WebPluginSlotProps) {
  const reported = useStore(workflows.store, (state) => workflows.select(state, sessionId).runs);
  const focused = useStore(workflows.store, (state) => workflows.select(state, sessionId).focusedRun);
  const runs = useMemo(() => reported.filter((candidate) => ownsRun(candidate, sessionId)), [reported, sessionId]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const run = runs.find((candidate) => workflowRunIdentity(candidate) === focused) ?? runs[0];
  if (run === undefined) {
    return (
      <EmptyState
        data-testid="workflow-dock-empty"
        className="px-4 py-5"
        title="this session has no workflow run"
        description="a run launched from here shows its jobs, steps and artifacts in this face."
      >
        <Button
          variant="outline"
          size="sm"
          data-testid="workflow-dock-launch"
          onClick={() => {
            if (sessionId !== null) openCatalog(sessionId);
          }}
        >
          launch workflow
        </Button>
      </EmptyState>
    );
  }

  return (
    <WorkflowDockView
      runs={runs}
      run={run}
      now={now}
      sessionId={sessionId}
      onSelectRun={(candidate) => {
        if (sessionId !== null) focusRun(sessionId, workflowRunIdentity(candidate));
      }}
      onOpenStep={(job, step) => openTransientTab(stepTerminalTab(run, job, step))}
      onDeleted={() => {
        if (sessionId !== null) removeRun(sessionId, workflowRunIdentity(run));
      }}
      artifacts={
        <ArtifactsPane run={run} sessionId={sessionId} onOpen={(path) => openTransientTab(artifactTab(run, path))} />
      }
    />
  );
}
