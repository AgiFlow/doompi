import fs from 'node:fs';
import path from 'node:path';

import {
  connectNativeTerminal,
  type WorkflowProgressEvent,
  type WorkflowRegistryService,
  type WorkflowRunRecord,
} from '@agimon-ai/workflow-mcp';

import { STEP_PANE_REF_KIND, STEP_SESSION_REF_KIND } from '../../types/webWorkflows';
import type { WorkflowTerminalCapabilitiesView } from '../../types/webWorkflowTerminal';
import { stepPaneLogPath } from '../stepExecutor';
import type { TerminalPort } from '../workflowTerminal';
import type { RunStepRefs, StepPaneTerminalDependencies, StepRef } from './type';

const PROGRESS_FILENAME = 'progress.ndjson';
const NATIVE_LAUNCHER = 'native';
const PANE_CAPABILITIES: WorkflowTerminalCapabilitiesView = { readable: true, writable: true, resizable: false };
const PANE_LOG_CAPABILITIES: WorkflowTerminalCapabilitiesView = {
  readable: true,
  writable: false,
  resizable: false,
  reason: 'That step has finished; this is the output it left.',
};
const SESSION_STEP_REASON =
  'This step runs as an agent session; its conversation appears here as soon as the session starts.';
const PANE_GONE_LINE = 'The step pane has closed.';

/**
 * The step a run is on and its latest pane, folded from its progress log.
 *
 * Later events win, as in the engine's own summary. Only a step still running
 * is current; the latest pane is kept after it finishes so a run between steps,
 * or one that has ended, can still show what its last command printed.
 */
export function stepRefsFrom(events: readonly WorkflowProgressEvent[]): RunStepRefs {
  const steps = new Map<string, { running: boolean; ref?: StepRef }>();
  let current: string | undefined;
  let lastPane: StepRef | undefined;
  for (const event of events) {
    if (event.type !== 'step' || event.step === undefined) continue;
    const key = `${event.job}\u0000${event.step}`;
    const known = steps.get(key);
    steps.set(key, { running: event.status === 'running', ref: event.ref ?? known?.ref });
    if (event.status === 'running') current = key;
    if (event.ref?.kind === STEP_PANE_REF_KIND) lastPane = event.ref;
  }
  const step = current === undefined ? undefined : steps.get(current);
  return {
    ...(step?.running && step.ref ? { current: step.ref } : {}),
    ...(lastPane === undefined ? {} : { lastPane }),
  };
}

function readProgressEvents(file: string): WorkflowProgressEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // No log yet: a run records progress only once its first step starts.
    return [];
  }
  const events: WorkflowProgressEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as WorkflowProgressEvent);
    } catch {
      // A torn last line while the run is still appending; the next read sees it whole.
    }
  }
  return events;
}

/**
 * Real dependencies: the registry's run directory, and the step executor's pane sockets.
 *
 * A pane is reached through the socket its step was served on, so any scope
 * of the server can read it, and a finished one through the screen kept
 * beside that socket.
 */
export function createStepPaneTerminalDependencies(registry: WorkflowRegistryService): StepPaneTerminalDependencies {
  const native = connectNativeTerminal();
  return {
    stepRefs: (record) =>
      stepRefsFrom(readProgressEvents(path.join(registry.runDirectoryFor(record), PROGRESS_FILENAME))),
    paneClient: () => ({
      capture: (target) =>
        native.snapshot(target, {}).then(
          (lines) => lines.join('\n'),
          // A pane that already closed has no screen; its kept log answers instead.
          () => undefined,
        ),
      input: (target, text) =>
        native.write(target, text).then(
          () => true,
          () => false,
        ),
    }),
    paneLog: (_record, pane) =>
      fs.promises.readFile(stepPaneLogPath(pane.id), 'utf8').catch(
        // Kept screens live in the temp directory, which the system may already have cleared.
        () => undefined,
      ),
  };
}

function lastLines(text: string, count: number | undefined): string[] {
  const lines = text.replace(/\n+$/, '').split('\n');
  return count === undefined ? lines : lines.slice(-count);
}

/**
 * A run terminal that follows the step a host executor placed.
 *
 * A run executing in the server has no launcher pane of its own; each command
 * step gets one instead. While such a step runs, this reads and types into its
 * pane. While a customRun step runs, there is no terminal to show, so it says
 * where the agent's messages are. Between steps and after the run, an
 * in-process run shows what its latest command printed. A run delegated to a
 * terminal launcher keeps the engine's facade.
 */
export function createStepPaneTerminal(
  facade: TerminalPort<WorkflowRunRecord>,
  dependencies: StepPaneTerminalDependencies,
): TerminalPort<WorkflowRunRecord> {
  // A server run records the server itself as its native launcher and has no terminal socket.
  const inProcess = (record: WorkflowRunRecord): boolean =>
    record.launcher?.type === NATIVE_LAUNCHER && record.terminalSocket === undefined;
  const settledPane = (record: WorkflowRunRecord, refs: RunStepRefs): StepRef | undefined =>
    refs.current === undefined && inProcess(record) ? refs.lastPane : undefined;

  return {
    capabilities(record) {
      const refs = dependencies.stepRefs(record);
      if (refs.current?.kind === STEP_PANE_REF_KIND) return PANE_CAPABILITIES;
      if (refs.current?.kind === STEP_SESSION_REF_KIND) {
        return { readable: false, writable: false, resizable: false, reason: SESSION_STEP_REASON };
      }
      if (settledPane(record, refs) !== undefined) return PANE_LOG_CAPABILITIES;
      return facade.capabilities(record);
    },
    async screen(record, options) {
      const refs = dependencies.stepRefs(record);
      if (refs.current?.kind === STEP_SESSION_REF_KIND) return [SESSION_STEP_REASON];
      if (refs.current?.kind === STEP_PANE_REF_KIND) {
        const screen = await dependencies.paneClient(record).capture(refs.current.id);
        if (screen !== undefined) return lastLines(screen, options.lines);
        // The pane closed between the progress read and the capture; its log has the same text.
        const log = await dependencies.paneLog(record, refs.current);
        return log === undefined ? [PANE_GONE_LINE] : lastLines(log, options.lines);
      }
      const pane = settledPane(record, refs);
      if (pane === undefined) return facade.screen(record, options);
      const log = await dependencies.paneLog(record, pane);
      return log === undefined ? [PANE_GONE_LINE] : lastLines(log, options.lines);
    },
    async write(record, data) {
      const refs = dependencies.stepRefs(record);
      if (refs.current?.kind !== STEP_PANE_REF_KIND) return facade.write(record, data);
      if (!(await dependencies.paneClient(record).input(refs.current.id, data))) throw new Error(PANE_GONE_LINE);
    },
    async resize(record, columns, rows) {
      const refs = dependencies.stepRefs(record);
      if (refs.current !== undefined || settledPane(record, refs) !== undefined) return false;
      return facade.resize(record, columns, rows);
    },
  };
}
