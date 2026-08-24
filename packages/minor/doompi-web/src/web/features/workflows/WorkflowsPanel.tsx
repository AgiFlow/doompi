import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import type { WorkflowJobView, WorkflowProgressState, WorkflowRunView, WorkflowStepView } from '../../../types/hub.ts';
import { formatRunDuration } from '../../lib/sessionSummary.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';
import { workflowsStore } from '../../stores/workflowsStore.ts';

const TICK_MS = 10_000;

interface RunTone {
  label: string;
  className: string;
  dot: string;
}

/** One word per run, the way the mockup's chips read: state first, outcome when finished. */
function runTone(run: WorkflowRunView): RunTone {
  if (run.stage === 'running' && (run.executionState === 'paused' || run.executionState === 'pause_requested')) {
    return { label: 'PAUSED', className: 'bg-[#312A1C] text-doom-yellow', dot: 'bg-doom-yellow' };
  }
  if (run.stage === 'running')
    return { label: 'RUNNING', className: 'bg-[#312A1C] text-doom-yellow', dot: 'bg-doom-yellow' };
  if (run.stage === 'error') return { label: 'FAILED', className: 'bg-[#332428] text-doom-red', dot: 'bg-doom-red' };
  if (run.outcome !== undefined && run.outcome !== 'success') {
    return { label: run.outcome.toUpperCase(), className: 'bg-doom-panel text-doom-faint', dot: 'bg-doom-faint' };
  }
  return { label: 'DONE', className: 'bg-[#262E1E] text-doom-green', dot: 'bg-doom-green' };
}

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

function runIdentity(run: WorkflowRunView): string {
  return `${run.workspace}/${run.runKey}`;
}

/** Needs-you facts for one run: an error to recover, or a pause waiting on someone. */
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

function NowLine({ run }: { run: WorkflowRunView }) {
  if (run.stage !== 'running' || run.position === undefined) return null;
  return (
    <div data-testid="workflow-now" className="flex items-center gap-2 pb-3">
      <span className="rounded-[3px] bg-[#21313F] px-1.5 py-0.5 text-[8px] font-bold text-doom-blue">NOW</span>
      <span className="truncate text-[11px] text-doom-hi">
        {run.workflowName ?? run.displayName}
        <span className="text-doom-faint"> › </span>
        {run.position.job}
        {run.position.step === undefined ? null : (
          <>
            <span className="text-doom-faint"> · </span>
            <span className="text-doom-text">{run.position.step}</span>
          </>
        )}
      </span>
      {run.position.index !== undefined && run.position.total !== undefined ? (
        <span className="shrink-0 text-[9px] text-doom-faint">
          job {run.position.index + 1}/{run.position.total}
        </span>
      ) : null}
    </div>
  );
}

function AttentionStrip({ runs }: { runs: WorkflowRunView[] }) {
  const items = runs
    .map((run) => ({ run, attention: attentionFor(run) }))
    .filter(
      (entry): entry is { run: WorkflowRunView; attention: NonNullable<ReturnType<typeof attentionFor>> } =>
        entry.attention !== undefined,
    );
  if (items.length === 0) return null;
  return (
    <div data-testid="workflow-needs-you" className="flex flex-col gap-2 pb-3">
      <span className="text-[9px] font-bold tracking-[0.18em] text-doom-yellow">NEEDS YOU · {items.length}</span>
      {items.map(({ run, attention }) => (
        <div
          key={runIdentity(run)}
          data-testid={`needs-card-${run.runKey}`}
          className={`flex flex-col gap-1 rounded-md border px-3 py-2.5 ${
            attention.kind === 'error' ? 'border-[#6B3A3A] bg-[#332428]/40' : 'border-[#574427] bg-[#312A1C]/40'
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`rounded-[3px] px-1.5 py-0.5 text-[8px] font-bold ${
                attention.kind === 'error' ? 'bg-[#332428] text-doom-red' : 'bg-[#312A1C] text-doom-yellow'
              }`}
            >
              {attention.kind === 'error' ? 'ERROR' : 'PAUSED'}
            </span>
            <span className="truncate text-[11px] font-bold text-doom-hi">{run.displayName}</span>
          </div>
          <span className="text-[10px] leading-relaxed text-doom-text">{attention.text}</span>
          <span className="text-[9px] text-doom-faint">
            {attention.kind === 'error'
              ? 'recover it from the owning session: ask the agent to recover this run, or use its workflow recovery surface'
              : 'resume it from the owning session'}
          </span>
        </div>
      ))}
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
  const phaseTone = job.phase === 'job' ? 'text-doom-text' : 'text-doom-faint';
  return (
    <button
      type="button"
      data-testid={`job-row-${job.name}`}
      data-job-status={job.status}
      onClick={onSelect}
      className={`flex items-center gap-2 rounded px-2.5 py-1.5 text-left ${
        selected ? 'bg-[#21313F]' : 'hover:bg-doom-panel'
      }`}
    >
      <span className={`w-3 shrink-0 text-[10px] ${icon.className}`}>{icon.glyph}</span>
      <span className={`min-w-0 flex-1 truncate text-[11px] ${selected ? 'text-doom-hi' : phaseTone}`}>{job.name}</span>
      <span className="shrink-0 text-[9px] text-doom-faint">{spanDuration(job.startedAt, job.endedAt, now) ?? ''}</span>
    </button>
  );
}

function StepRow({ step, now }: { step: WorkflowStepView; now: number }) {
  const icon = STATE_ICON[step.status];
  return (
    <div
      data-testid={`step-row-${step.name}`}
      data-step-status={step.status}
      className="flex flex-col gap-0.5 px-3 py-1.5"
    >
      <div className="flex items-center gap-2">
        <span className={`w-3 shrink-0 text-[10px] ${icon.className}`}>{icon.glyph}</span>
        <span
          className={`min-w-0 flex-1 truncate text-[11px] ${step.status === 'failed' ? 'text-doom-red' : 'text-doom-text'}`}
        >
          {step.name}
        </span>
        <span className="shrink-0 text-[9px] text-doom-faint">
          {spanDuration(step.startedAt, step.endedAt, now) ?? ''}
        </span>
      </div>
      {step.reason === undefined ? null : (
        <span className={`pl-5 text-[9px] ${step.status === 'failed' ? 'text-doom-red' : 'text-doom-faint'}`}>
          {step.reason}
        </span>
      )}
      {ACTIVE_STATES.has(step.status) && step.status !== 'paused' ? (
        <span className="ml-5 mt-0.5 inline-block h-[10px] w-1.5 bg-doom-blue" />
      ) : null}
    </div>
  );
}

/**
 * The workflows tab: GitHub-Actions-shaped runs for the focused session.
 *
 * What the registry records is what renders: the run chips and needs-you strip
 * come from run.json, the jobs pane and step rows from the folded progress
 * log. The view is read-only; recovery and resume stay with the session that
 * owns the run.
 */
export function WorkflowsPanel() {
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const runs = useStore(workflowsStore, (state) => (activeId === null ? [] : (state.bySession[activeId] ?? [])));
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const run = runs.find((candidate) => runIdentity(candidate) === selectedRun) ?? runs[0];
  const jobs = run?.jobs ?? [];
  const fallbackJob =
    run?.position?.job ?? jobs.find((job) => ACTIVE_STATES.has(job.status))?.name ?? jobs.at(-1)?.name;
  const job =
    jobs.find((candidate) => candidate.name === selectedJob) ??
    jobs.find((candidate) => candidate.name === fallbackJob);
  const runningTally = runs.filter((candidate) => candidate.stage === 'running').length;
  const attentionTally = runs.filter((candidate) => attentionFor(candidate) !== undefined).length;

  return (
    <div data-testid="workflows-panel" className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-[26px] py-[18px]">
        <div className="flex items-center pb-3">
          <span className="text-[9px] font-bold tracking-[0.18em] text-doom-faint">WORKFLOWS · this session</span>
          <span className="min-w-0 flex-1" />
          <span data-testid="workflows-tally" className="text-[9px] text-doom-faint">
            {runs.length === 0 ? 'no runs yet' : `${runningTally} running · ${runs.length} total`}
          </span>
        </div>
        {runs.length === 0 ? (
          <div data-testid="workflows-empty" className="flex flex-1 items-center justify-center">
            <div className="flex w-[420px] flex-col items-center gap-2 text-center">
              <span className="text-[13px] font-bold text-doom-hi">no workflow runs yet</span>
              <span className="text-[11px] leading-relaxed text-doom-dim">
                launch one from the session (its workflow tools or SPC w l) and the run will show up here live, jobs and
                steps included.
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 pb-3">
              {runs.map((candidate) => {
                const tone = runTone(candidate);
                const active = run !== undefined && runIdentity(candidate) === runIdentity(run);
                return (
                  <button
                    key={runIdentity(candidate)}
                    type="button"
                    data-testid={`workflow-chip-${candidate.runKey}`}
                    data-run-stage={candidate.stage}
                    data-active={active}
                    onClick={() => {
                      setSelectedRun(runIdentity(candidate));
                      setSelectedJob(null);
                    }}
                    className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-[10px] ${
                      active
                        ? 'border-doom-blue/60 bg-[#21313F] font-bold text-doom-hi'
                        : 'border-doom-border bg-doom-panel text-doom-dim hover:text-doom-hi'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                    {candidate.displayName}
                  </button>
                );
              })}
              <span className="min-w-0 flex-1" />
              <span
                data-testid="workflow-attention-tally"
                className={`text-[10px] ${attentionTally > 0 ? 'font-bold text-doom-yellow' : 'text-doom-green'}`}
              >
                {attentionTally > 0 ? `${attentionTally} need you` : 'nothing needs you'}
              </span>
            </div>
            {run === undefined ? null : (
              <>
                <NowLine run={run} />
                <AttentionStrip runs={runs} />
                <div className="flex min-h-0 flex-1 gap-4">
                  <div
                    data-testid="jobs-pane"
                    className="flex w-[300px] shrink-0 flex-col gap-0.5 overflow-y-auto rounded-md border border-doom-border bg-doom-panel p-2"
                  >
                    <div className="flex items-center px-2.5 pb-1.5 pt-1">
                      <span className="text-[9px] font-bold tracking-[0.14em] text-doom-faint">JOBS</span>
                      <span className="min-w-0 flex-1" />
                      <span className="text-[9px] text-doom-faint">
                        {jobs.filter((candidate) => candidate.status === 'completed').length}/{jobs.length} done
                      </span>
                    </div>
                    {jobs.length === 0 ? (
                      <span className="px-2.5 py-2 text-[10px] text-doom-faint">no progress recorded yet</span>
                    ) : (
                      jobs.map((candidate) => (
                        <JobRow
                          key={candidate.name}
                          job={candidate}
                          now={now}
                          selected={job !== undefined && candidate.name === job.name}
                          onSelect={() => setSelectedJob(candidate.name)}
                        />
                      ))
                    )}
                  </div>
                  <div
                    data-testid="job-pane"
                    className="flex min-w-0 flex-1 flex-col overflow-y-auto rounded-md border border-doom-border bg-doom-panel"
                  >
                    {job === undefined ? (
                      <span className="px-4 py-3 text-[10px] text-doom-faint">select a job to see its steps</span>
                    ) : (
                      <>
                        <div className="flex items-center gap-2.5 border-b border-doom-border-soft px-4 py-2.5">
                          <span data-testid="job-pane-name" className="truncate text-[12px] font-bold text-doom-hi">
                            {job.name}
                          </span>
                          <span
                            className={`rounded-[3px] px-[7px] py-[3px] text-[9px] font-bold ${
                              STATE_ICON[job.status].className
                            } bg-doom-deep`}
                          >
                            {job.status.replace('_', ' ')}
                          </span>
                          <span className="min-w-0 flex-1" />
                          <span className="text-[9px] text-doom-faint">
                            {spanDuration(job.startedAt, job.endedAt, now) ?? ''}
                          </span>
                        </div>
                        <div className="flex flex-col py-1.5">
                          {job.steps.length === 0 ? (
                            <span className="px-4 py-2 text-[10px] text-doom-faint">no steps recorded yet</span>
                          ) : (
                            job.steps.map((step) => <StepRow key={step.name} step={step} now={now} />)
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <span className="pt-3 text-[9px] text-doom-faint">
                  read from the workflow registry live · errored runs stay a day for recovery · finished runs leave
                  after 10m
                </span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
