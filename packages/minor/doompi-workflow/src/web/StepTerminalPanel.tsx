import { Badge, Button, StatusBadge, StreamCursor } from '@agimon-ai/doompi-web-components';
import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowRunView } from '../types/webWorkflows.ts';
import type { WorkflowTerminalCapabilitiesView } from '../types/webWorkflowTerminal.ts';
import { ansiSpans } from './ansiSpans.ts';
import { followScreen, releaseControl, sendKeys, takeControl } from './terminalApi.ts';
import { workflows } from './workflowsStore.ts';

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

function ScreenLine({ line }: { line: string }) {
  const spans = ansiSpans(line);
  if (spans.length === 0) return <span className="block h-[15px]" />;
  return (
    <span className="block whitespace-pre">
      {spans.map((span, index) => (
        <span
          key={index}
          className={`${span.className ?? ''} ${span.bold ? 'font-bold' : ''} ${span.faint ? 'opacity-60' : ''} ${
            span.italic ? 'italic' : ''
          } ${span.underline ? 'underline' : ''} ${span.inverse ? 'bg-doom-text text-doom-deep' : ''}`}
          style={span.color === undefined ? undefined : { color: span.color }}
        >
          {span.text}
        </span>
      ))}
    </span>
  );
}

/**
 * One run's terminal, under a header naming the step the reader opened it from.
 *
 * A run has one terminal, shared by its steps in sequence, so this is the run's
 * screen and the header says which step is on it. Watching is free; typing
 * takes the keyboard first, because the pane belongs to whoever is answering
 * whatever the nested agent asked.
 */
export function StepTerminalPanel({ sessionId, target }: WebPluginSlotProps & { target: StepTabTarget }) {
  const runs = useStore(workflows.store, (state) => workflows.select(state, sessionId).runs);
  const run = runs.find((candidate) => candidate.workspace === target.workspace && candidate.runKey === target.runKey);
  const [lines, setLines] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<WorkflowTerminalCapabilitiesView>();
  const [ended, setEnded] = useState(false);
  const [token, setToken] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const screenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A new run's screen has not ended yet; the subscription below is the external system.
    // oxlint-disable-next-line react/set-state-in-effect
    setEnded(false);
    return followScreen(target.workspace, target.runKey, (event) => {
      setLines(event.lines);
      setCapabilities(event.capabilities);
      if (event.ended === true) setEnded(true);
    });
  }, [target.workspace, target.runKey]);

  // The keyboard is a lease on the hub, so a tab that goes away must hand it
  // back rather than leaving the next reader locked out until it expires.
  useEffect(() => {
    if (token === undefined) return;
    return () => {
      void releaseControl(target.workspace, target.runKey, token);
    };
  }, [token, target.workspace, target.runKey]);

  useEffect(() => {
    screenRef.current?.scrollTo({ top: screenRef.current.scrollHeight });
  }, [lines]);

  const arm = useCallback(async () => {
    const result = await takeControl(target.workspace, target.runKey);
    if (result.held && result.token !== undefined) {
      setToken(result.token);
      setNotice(undefined);
      return;
    }
    setNotice(result.reason ?? 'The keyboard is not available for this run.');
  }, [target.workspace, target.runKey]);

  const disarm = useCallback(async () => {
    if (token !== undefined) await releaseControl(target.workspace, target.runKey, token);
    setToken(undefined);
  }, [token, target.workspace, target.runKey]);

  const type = async (data: string): Promise<void> => {
    if (token === undefined) return;
    const { error } = await sendKeys(target.workspace, target.runKey, token, data);
    if (error !== undefined) {
      setNotice(error);
      setToken(undefined);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (token === undefined) return;
    if (event.key === 'Escape' && !event.ctrlKey) {
      event.preventDefault();
      void disarm();
      return;
    }
    const control = CONTROL_KEYS[event.key];
    if (control !== undefined) {
      event.preventDefault();
      void type(control);
      return;
    }
    if (event.ctrlKey && event.key.length === 1) {
      event.preventDefault();
      const letter = event.key.toUpperCase().charCodeAt(0);
      void type(event.key === 'c' ? CTRL_C : event.key === 'd' ? CTRL_D : String.fromCharCode(letter - CTRL_A_CODE));
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.altKey) {
      event.preventDefault();
      void type(event.key);
    }
  };

  const held = token !== undefined;
  const writable = capabilities?.writable === true;

  return (
    <div data-testid="step-terminal-panel" className="flex min-h-0 flex-1 flex-col px-[26px] py-[18px]">
      <div data-testid="step-terminal-head" className="flex items-center gap-2.5 pb-3">
        <span className="shrink-0 truncate text-[12px] font-bold text-doom-hi">
          {run?.displayName ?? target.runKey}
        </span>
        <span className="text-[10px] text-doom-faint">›</span>
        <span className="shrink-0 truncate text-[11px] font-bold text-doom-blue">{target.job}</span>
        {target.step === undefined ? null : (
          <>
            <span className="text-[10px] text-doom-faint">›</span>
            <span className="min-w-0 truncate text-[11px] text-doom-text">{target.step}</span>
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
            onClick={() => void (held ? disarm() : arm())}
          >
            {held ? 'release keyboard' : 'take control'}
          </Button>
        ) : null}
      </div>
      <div
        ref={screenRef}
        data-testid="step-terminal-screen"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={`min-h-0 flex-1 overflow-y-auto rounded-md border bg-doom-deep px-4 py-3 font-mono text-[11px] leading-[15px] text-doom-text outline-none ${
          held ? 'border-doom-blue/60' : 'border-doom-border'
        }`}
      >
        {lines.length === 0 ? (
          <span className="text-[10px] text-doom-faint">
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
        <span data-testid="step-terminal-hint" className="text-[9px] text-doom-faint">
          {held
            ? 'keys go to the run · ctrl-c and ctrl-d pass through · esc releases the keyboard'
            : capabilities?.writable === false
              ? (capabilities.reason ?? 'this run cannot be typed into')
              : 'read-only until you take control · the run keeps going either way'}
        </span>
        <span className="min-w-0 flex-1" />
        {ended ? (
          <span data-testid="step-terminal-ended" className="text-[9px] text-doom-faint">
            the run has settled; this is its last screen
          </span>
        ) : null}
        {notice === undefined ? null : (
          <span data-testid="step-terminal-notice" className="text-[9px] text-doom-yellow">
            {notice}
          </span>
        )}
      </div>
    </div>
  );
}
