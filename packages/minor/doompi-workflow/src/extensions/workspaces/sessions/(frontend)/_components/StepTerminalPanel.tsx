import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { AnsiLine, Badge, Button, StatusBadge, StreamCursor } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
} from 'react';

import {
  STEP_PANE_REF_KIND,
  STEP_SESSION_REF_KIND,
  type WorkflowRunView,
  type WorkflowStepRefView,
  type WorkflowStepView,
} from '../../../../../types/webWorkflows';
import type { WorkflowTerminalCapabilitiesView } from '../../../../../types/webWorkflowTerminal';
import { createKeySender } from '../_lib/keySender';
import { followScreen, releaseControl, sendKeys, takeControl } from '../_lib/terminalApi';
import { workflows } from '../_lib/workflowsStore';
import { StepSteerComposer } from './StepSteerComposer';

/** The tab id doubles as the URL segment, so it stays plain and unique across plugins. */
const TAB_ID_PREFIX = 'workflows-step-';
/** Keys that mean something to a terminal but nothing to a text field. */
const CONTROL_KEYS: Readonly<Record<string, string>> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
};
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const CTRL_A_CODE = 64;

export interface StepTabTarget {
  workspace: string;
  runKey: string;
  /** The job and step the reader clicked, which the header names. */
  job: string;
  step?: string;
}

/** The temporary tab for one step; the host keeps this panel while the tab is open. */
export function stepTerminalTab(run: WorkflowRunView, job: string, step?: string): TransientTab {
  const target: StepTabTarget = {
    workspace: run.workspace,
    runKey: run.runKey,
    job,
    ...(step === undefined ? {} : { step }),
  };
  const label = step ?? job;
  return {
    id: `${TAB_ID_PREFIX}${run.workspace}-${run.runKey}-${job}${step === undefined ? '' : `-${step}`}`.replace(
      /[^\w-]+/g,
      '-',
    ),
    label: `${run.displayName} › ${label}`,
    panel: (props: WebPluginSlotProps) => <StepTerminalPanel {...props} target={target} />,
  };
}

/**
 * The child session a customRun step ran as, when the tab shows one.
 *
 * A step tab follows that step. A job tab follows the job's latest step only,
 * so a job that moved on to a command step shows its terminal again.
 */
/** The step a tab points at: the named one, or the job's last step when it names none. */
function targetStep(run: WorkflowRunView | undefined, target: StepTabTarget): WorkflowStepView | undefined {
  const steps = run?.jobs.find((job) => job.name === target.job)?.steps ?? [];
  return target.step === undefined ? steps.at(-1) : steps.find((candidate) => candidate.name === target.step);
}

/** The pane of the step a tab points at, so a parallel group's steps each read their own. */
export function stepPaneId(run: WorkflowRunView | undefined, target: StepTabTarget): string | undefined {
  const ref = targetStep(run, target)?.ref;
  return ref?.kind === STEP_PANE_REF_KIND ? ref.id : undefined;
}

export function stepSessionRef(
  run: WorkflowRunView | undefined,
  target: StepTabTarget,
): WorkflowStepRefView | undefined {
  const step = targetStep(run, target);
  return step?.ref?.kind === STEP_SESSION_REF_KIND ? step.ref : undefined;
}

function ScreenLine({ line }: { line: string }) {
  // A blank row still has to hold the grid open, so an empty line keeps its
  // height rather than collapsing the screen by one row.
  if (line.length === 0) return <span className="block h-[15px]" />;
  return <AnsiLine line={line} className="block whitespace-pre" />;
}

/** The run, job and step the tab was opened from, with the run's stage and any controls. */
function StepHeader({
  run,
  target,
  children,
}: {
  run: WorkflowRunView | undefined;
  target: StepTabTarget;
  children?: ReactNode;
}) {
  return (
    <div data-testid="step-terminal-head" className="flex items-center gap-2.5 pb-3">
      <span className="shrink-0 truncate text-sm font-bold text-doom-hi">{run?.displayName ?? target.runKey}</span>
      <span className="text-xs text-doom-faint">›</span>
      <span className="shrink-0 truncate text-sm font-bold text-doom-blue">{target.job}</span>
      {target.step === undefined ? null : (
        <>
          <span className="text-xs text-doom-faint">›</span>
          <span className="min-w-0 truncate text-sm text-doom-text">{target.step}</span>
        </>
      )}
      {run === undefined ? null : (
        <StatusBadge
          tone={run.stage === 'running' ? 'running' : run.stage === 'error' ? 'error' : 'ok'}
          data-testid="step-terminal-stage"
        >
          {run.stage}
        </StatusBadge>
      )}
      <span className="min-w-0 flex-1" />
      {children}
    </div>
  );
}

/**
 * One step of a run: the agent conversation for a customRun step, else the run's terminal.
 *
 * A customRun step runs as a child session, so its real messages replace the
 * screen a shell step would paint. The session outlives the step, so a
 * finished step still reads back.
 */
export function StepTerminalPanel(props: WebPluginSlotProps & { target: StepTabTarget }) {
  const { sessionId, target, renderSessionTranscript } = props;
  const runs = useStore(workflows.store, (state) => workflows.select(state, sessionId).runs);
  const run = runs.find((candidate) => candidate.workspace === target.workspace && candidate.runKey === target.runKey);
  const sessionRef = stepSessionRef(run, target);
  if (sessionRef !== undefined && renderSessionTranscript !== undefined) {
    return (
      <div data-testid="step-conversation-panel" className="flex min-h-0 flex-1 flex-col px-[26px] py-[18px]">
        <StepHeader run={run} target={target}>
          <Badge size="xs" tone="blue" data-testid="step-conversation-session">
            agent session
          </Badge>
        </StepHeader>
        <div data-testid="step-conversation" className="flex min-h-0 flex-1 flex-col">
          {renderSessionTranscript(sessionRef.id)}
        </div>
        {run?.stage === 'running' && targetStep(run, target)?.status === 'running' ? (
          <StepSteerComposer key={sessionRef.id} run={run} sessionId={sessionId} step={sessionRef.id} />
        ) : null}
      </div>
    );
  }
  return <StepTerminal sessionId={sessionId} target={target} run={run} />;
}

/**
 * One run's terminal, under a header naming the step the reader opened it from.
 *
 * A run has one terminal, shared by its steps in sequence, so this is the run's
 * screen and the header says which step is on it. Watching is free; typing
 * takes the keyboard first, because the pane belongs to whoever is answering
 * whatever the nested agent asked.
 */
function StepTerminal({
  sessionId,
  target,
  run,
}: {
  sessionId: string | null;
  target: StepTabTarget;
  run: WorkflowRunView | undefined;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<WorkflowTerminalCapabilitiesView>();
  const [ended, setEnded] = useState(false);
  const [token, setToken] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const screenRef = useRef<HTMLDivElement>(null);
  // The step's own pane, so each step of a parallel group has its own screen and keyboard.
  const pane = stepPaneId(run, target);
  // The run the panel shows right now, cleared on unmount. A keyboard grant that comes back for
  // any other run is released at once instead of being held for a panel that moved on.
  const targetKey = `${sessionId ?? ''}\0${target.workspace}\0${target.runKey}\0${pane ?? ''}`;
  const currentTarget = useRef<string | undefined>(targetKey);
  useEffect(() => {
    currentTarget.current = targetKey;
    return () => {
      currentTarget.current = undefined;
    };
  }, [targetKey]);

  useEffect(() => {
    // A new run's screen has not ended yet; the subscription below is the external system.
    // oxlint-disable-next-line react/set-state-in-effect
    setEnded(false);
    return followScreen(
      target.workspace,
      target.runKey,
      (event) => {
        setLines(event.lines);
        setCapabilities(event.capabilities);
        if (event.ended === true) setEnded(true);
      },
      sessionId,
      pane,
    );
  }, [sessionId, target.workspace, target.runKey, pane]);

  // The keyboard is a lease on the hub, so a tab that goes away must hand it
  // back rather than leaving the next reader locked out until it expires.
  useEffect(() => {
    if (token === undefined) return;
    return () => {
      void releaseControl(target.workspace, target.runKey, token, sessionId, pane);
    };
  }, [sessionId, token, target.workspace, target.runKey, pane]);

  useEffect(() => {
    screenRef.current?.scrollTo({ top: screenRef.current.scrollHeight });
  }, [lines]);

  const arm = useCallback(async () => {
    const requested = targetKey;
    const result = await takeControl(target.workspace, target.runKey, undefined, sessionId, pane);
    if (currentTarget.current !== requested) {
      if (result.held && result.token !== undefined)
        void releaseControl(target.workspace, target.runKey, result.token, sessionId, pane);
      return;
    }
    if (result.held && result.token !== undefined) {
      setToken(result.token);
      setNotice(undefined);
      return;
    }
    setNotice(result.reason ?? 'The keyboard is not available for this run.');
  }, [sessionId, target.workspace, target.runKey, targetKey, pane]);

  // Dropping the token is the release: the lease effect's cleanup hands it back exactly once.
  const disarm = useCallback(() => {
    setToken(undefined);
  }, []);

  const typeKeys = useMemo(
    () =>
      token === undefined
        ? undefined
        : createKeySender(async (data) => {
            const { error } = await sendKeys(target.workspace, target.runKey, token, data, sessionId, pane);
            if (error === undefined) return true;
            setNotice(error);
            setToken(undefined);
            return false;
          }),
    [token, target.workspace, target.runKey, sessionId, pane],
  );
  const type = (data: string): void => typeKeys?.(data);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (token === undefined) return;
    if (event.key === 'Escape' && !event.ctrlKey) {
      event.preventDefault();
      disarm();
      return;
    }
    const control = CONTROL_KEYS[event.key];
    if (control !== undefined) {
      event.preventDefault();
      type(control);
      return;
    }
    if (event.ctrlKey && event.key.length === 1) {
      event.preventDefault();
      const letter = event.key.toUpperCase().charCodeAt(0);
      type(event.key === 'c' ? CTRL_C : event.key === 'd' ? CTRL_D : String.fromCharCode(letter - CTRL_A_CODE));
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.altKey) {
      event.preventDefault();
      type(event.key);
    }
  };

  const held = token !== undefined;
  const writable = capabilities?.writable === true;

  return (
    <div data-testid="step-terminal-panel" className="flex min-h-0 flex-1 flex-col px-[26px] py-[18px]">
      <StepHeader run={run} target={target}>
        <Badge
          size="xs"
          tone={held ? 'blue' : 'neutral'}
          data-testid="step-terminal-control"
          className={held ? 'border-doom-blue/60 bg-doom-tint-blue text-doom-hi' : ''}
        >
          {held ? 'keyboard yours' : 'watching'}
        </Badge>
        {writable ? (
          <Button
            variant={held ? 'outline' : 'primary'}
            size="xs"
            data-testid="step-terminal-arm"
            onClick={() => (held ? disarm() : void arm())}
          >
            {held ? 'release keyboard' : 'take control'}
          </Button>
        ) : null}
      </StepHeader>
      <div
        ref={screenRef}
        data-testid="step-terminal-screen"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={`min-h-0 flex-1 overflow-y-auto rounded-md border bg-doom-deep px-4 py-3 font-mono text-sm leading-tight text-doom-text outline-none ${
          held ? 'border-doom-blue/60' : 'border-doom-border'
        }`}
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
        {held && !ended ? <StreamCursor className="mt-0.5 h-[12px] w-1.5" /> : null}
      </div>
      <div className="flex items-center gap-3 pt-2.5">
        <span data-testid="step-terminal-hint" className="text-2xs text-doom-faint">
          {held
            ? 'keys go to the run · ctrl-c and ctrl-d pass through · esc releases the keyboard'
            : capabilities?.writable === false
              ? (capabilities.reason ?? 'this run cannot be typed into')
              : 'read-only until you take control · the run keeps going either way'}
        </span>
        <span className="min-w-0 flex-1" />
        {ended ? (
          <span data-testid="step-terminal-ended" className="text-2xs text-doom-faint">
            the run has settled; this is its last screen
          </span>
        ) : null}
        {notice === undefined ? null : (
          <span data-testid="step-terminal-notice" className="text-2xs text-doom-yellow">
            {notice}
          </span>
        )}
      </div>
    </div>
  );
}
