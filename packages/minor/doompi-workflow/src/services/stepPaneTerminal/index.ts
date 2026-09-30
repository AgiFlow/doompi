import fs from 'node:fs';
import path from 'node:path';

import { connectNativeTerminal, type WorkflowRegistryService, type WorkflowRunRecord } from '@agimon-ai/workflow-mcp';

import { STEP_PANE_REF_KIND, STEP_SESSION_REF_KIND } from '../../types/webWorkflows';
import type { WorkflowTerminalCapabilitiesView } from '../../types/webWorkflowTerminal';
import { stepPaneLogPath } from '../stepExecutor';
import { parseWorkflowProgress } from '../workflowRuns';
import type { TerminalPort } from '../workflowTerminal';
import type { RunStepRefs, RunTerminalTarget, StepPaneTerminalDependencies, StepRef } from './type';

const PROGRESS_FILENAME = 'progress.ndjson';
const NATIVE_LAUNCHER = 'native';
/** Runs whose folded refs are kept between reads; a screen stream reads its run twice a second. */
const REFS_CACHE_LIMIT = 256;
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

/** The step events this fold reads, as the shared progress parser returns them. */
interface StepProgressEvent {
  readonly type: string;
  readonly status: string;
  readonly job: string;
  readonly step?: string;
  readonly index?: number;
  readonly ref?: StepRef;
}

/**
 * The steps a run is on and its latest pane, folded from its progress log.
 *
 * Later events win, as in the engine's own summary. Steps of a parallel group
 * run at once, so every running step is kept, and the current one is the
 * latest-started step still running. A step that starts again is a new
 * attempt: its previous session or pane is not this attempt's, so the ref is
 * dropped until the new one is recorded. The latest pane is kept after it
 * finishes so a run between steps, or one that has ended, can still show what
 * its last command printed.
 */
export function stepRefsFrom(events: readonly StepProgressEvent[]): RunStepRefs {
  // Insertion order is start order: a step that starts again moves to the end.
  const steps = new Map<string, { running: boolean; ref?: StepRef }>();
  const known = new Map<string, StepRef>();
  let lastPane: StepRef | undefined;
  for (const event of events) {
    if (event.type !== 'step' || event.step === undefined) continue;
    const key = `${event.job}\u0000${event.step}`;
    const previous = steps.get(key);
    const running = event.status === 'running';
    // Indexed starts also replace attempts interrupted while still running.
    const restarted = running && (event.index !== undefined || previous?.running !== true);
    if (restarted) steps.delete(key);
    const ref = event.ref ?? (restarted ? undefined : previous?.ref);
    steps.set(key, { running, ...(ref === undefined ? {} : { ref }) });
    if (event.ref !== undefined) known.set(event.ref.id, event.ref);
    if (event.ref?.kind === STEP_PANE_REF_KIND) lastPane = event.ref;
  }
  const running = [...steps.values()]
    .filter((step) => step.running && step.ref !== undefined)
    .map((step) => step.ref as StepRef);
  const current = running.at(-1);
  return {
    ...(current === undefined ? {} : { current }),
    ...(running.length === 0 ? {} : { running }),
    ...(lastPane === undefined ? {} : { lastPane }),
    ...(known.size === 0 ? {} : { known: [...known.values()] }),
  };
}

/**
 * Reads a run's refs, folding its progress log again only when the log changed.
 *
 * Every screen, keystroke and capability check asks for them, and the log grows
 * with every fix loop, so an unchanged file (same size and modification time)
 * answers from the last fold.
 */
function createStepRefsReader(): (file: string) => RunStepRefs {
  const cache = new Map<string, { size: number; mtimeMs: number; refs: RunStepRefs }>();
  return (file) => {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      // No log yet: a run records progress only once its first step starts.
      return {};
    }
    const cached = cache.get(file);
    if (cached !== undefined && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.refs;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      // Removed between the stat and the read, as a deleted run is; nothing is left to follow.
      return {};
    }
    const refs = stepRefsFrom(parseWorkflowProgress(raw));
    cache.delete(file);
    cache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, refs });
    if (cache.size > REFS_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    return refs;
  };
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
  const readRefs = createStepRefsReader();
  return {
    stepRefs: (record) => readRefs(path.join(registry.runDirectoryFor(record), PROGRESS_FILENAME)),
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

/** Removes the screens a run's finished panes left behind, once the run itself is deleted. */
export async function removeStepPaneLogs(refs: RunStepRefs): Promise<void> {
  const panes = (refs.known ?? []).filter((ref) => ref.kind === STEP_PANE_REF_KIND);
  await Promise.all(panes.map((pane) => fs.promises.rm(stepPaneLogPath(pane.id), { force: true })));
}

function lastLines(text: string, count: number | undefined): string[] {
  const lines = text.replace(/\n+$/, '').split('\n');
  return count === undefined ? lines : lines.slice(-count);
}

/** The ref a request reads, and whether its step is still running. */
interface ResolvedStep {
  readonly ref: StepRef;
  readonly running: boolean;
}

/**
 * A run terminal that follows the step a host executor placed.
 *
 * A run executing in the server has no launcher pane of its own; each command
 * step gets one instead. A request naming a step reads that step's pane, which
 * is how each step of a parallel group gets its own screen and keyboard.
 * Without one it follows the current step. While a customRun step runs, there
 * is no terminal to show, so it says where the agent's messages are. Between
 * steps and after the run, an in-process run shows what its latest command
 * printed. A run delegated to a terminal launcher keeps the engine's facade.
 */
export function createStepPaneTerminal(
  facade: TerminalPort<WorkflowRunRecord>,
  dependencies: StepPaneTerminalDependencies,
): TerminalPort<RunTerminalTarget> {
  // A server run records the server itself as its native launcher and has no terminal socket.
  const inProcess = (record: WorkflowRunRecord): boolean =>
    record.launcher?.type === NATIVE_LAUNCHER && record.terminalSocket === undefined;
  const resolveStep = (target: RunTerminalTarget): ResolvedStep | undefined => {
    const refs = dependencies.stepRefs(target.record);
    const isRunning = (ref: StepRef): boolean => refs.running?.some((candidate) => candidate.id === ref.id) === true;
    if (target.step !== undefined) {
      const named = refs.known?.find((ref) => ref.id === target.step);
      if (named !== undefined) return { ref: named, running: isRunning(named) };
    }
    if (refs.current !== undefined) return { ref: refs.current, running: true };
    if (refs.lastPane !== undefined && inProcess(target.record)) return { ref: refs.lastPane, running: false };
    return undefined;
  };
  const readLog = async (record: WorkflowRunRecord, pane: StepRef, lines: number | undefined): Promise<string[]> => {
    const log = await dependencies.paneLog(record, pane);
    return log === undefined ? [PANE_GONE_LINE] : lastLines(log, lines);
  };

  return {
    capabilities(target) {
      const step = resolveStep(target);
      if (step === undefined) return facade.capabilities(target.record);
      if (step.ref.kind === STEP_SESSION_REF_KIND) {
        return { readable: false, writable: false, resizable: false, reason: SESSION_STEP_REASON };
      }
      return step.running ? PANE_CAPABILITIES : PANE_LOG_CAPABILITIES;
    },
    async screen(target, options) {
      const step = resolveStep(target);
      if (step === undefined) return facade.screen(target.record, options);
      if (step.ref.kind === STEP_SESSION_REF_KIND) return [SESSION_STEP_REASON];
      if (step.running) {
        const screen = await dependencies.paneClient(target.record).capture(step.ref.id);
        if (screen !== undefined) return lastLines(screen, options.lines);
        // The pane closed between the progress read and the capture; its log has the same text.
      }
      return readLog(target.record, step.ref, options.lines);
    },
    async write(target, data) {
      const step = resolveStep(target);
      if (step === undefined) return facade.write(target.record, data);
      if (step.ref.kind !== STEP_PANE_REF_KIND || !step.running) throw new Error(PANE_GONE_LINE);
      if (!(await dependencies.paneClient(target.record).input(step.ref.id, data))) throw new Error(PANE_GONE_LINE);
    },
    async resize(target, columns, rows) {
      if (resolveStep(target) !== undefined) return false;
      return facade.resize(target.record, columns, rows);
    },
  };
}
