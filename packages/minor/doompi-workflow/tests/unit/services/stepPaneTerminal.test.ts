import type { WorkflowProgressEvent, WorkflowRunRecord } from '@agimon-ai/workflow-mcp';
import { describe, expect, it, vi } from 'vitest';

import { createStepPaneTerminal, stepRefsFrom } from '../../../src/services/stepPaneTerminal';
import type {
  RunStepRefs,
  RunTerminalTarget,
  StepPaneTerminalDependencies,
  StepRef,
} from '../../../src/services/stepPaneTerminal/type';
import { parseWorkflowProgress } from '../../../src/services/workflowRuns';
import type { TerminalPort } from '../../../src/services/workflowTerminal';

const PANE: StepRef = { kind: 'pane', id: 'doom-runner-workflow-1', label: 'Install' };
const SESSION: StepRef = { kind: 'session', id: 'child-session', label: 'Diagnose' };
const IN_PROCESS_RECORD = {
  runKey: 'r1',
  workspace: 'w',
  stage: 'running',
  workflowPath: '/repo/wf.yml',
  launcher: { type: 'native', pid: 42 },
} as WorkflowRunRecord;
const DELEGATED_RECORD = { ...IN_PROCESS_RECORD, launcher: { type: 'tmux', sessionName: 'wf' } } as WorkflowRunRecord;
const IN_PROCESS: RunTerminalTarget = { record: IN_PROCESS_RECORD };
const DELEGATED: RunTerminalTarget = { record: DELEGATED_RECORD };

function event(status: WorkflowProgressEvent['status'], step: string, ref?: StepRef): WorkflowProgressEvent {
  return { at: 'now', type: 'step', status, job: 'build', step, ...(ref ? { ref } : {}) };
}

function facade(): TerminalPort<WorkflowRunRecord> {
  return {
    capabilities: () => ({ readable: true, writable: true, resizable: true }),
    screen: vi.fn(async () => ['launcher screen']),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => true),
  };
}

function deps(refs: RunStepRefs, overrides: Partial<StepPaneTerminalDependencies> = {}): StepPaneTerminalDependencies {
  return {
    stepRefs: () => refs,
    paneClient: () => ({ capture: vi.fn(async () => undefined), input: vi.fn(async () => false) }),
    paneLog: vi.fn(async () => 'first\nsecond\n'),
    ...overrides,
  };
}

describe('stepRefsFrom', () => {
  it('keeps the running step ref and the latest pane, even after it finished', () => {
    expect(stepRefsFrom([event('running', 'Install'), event('running', 'Install', PANE)])).toEqual({
      current: PANE,
      running: [PANE],
      lastPane: PANE,
      known: [PANE],
    });
    expect(stepRefsFrom([event('running', 'Install', PANE), event('completed', 'Install')])).toEqual({
      lastPane: PANE,
      known: [PANE],
    });
    expect(
      stepRefsFrom([
        event('running', 'Install', PANE),
        event('completed', 'Install'),
        event('running', 'Diagnose'),
        event('running', 'Diagnose', SESSION),
      ]),
    ).toEqual({ current: SESSION, running: [SESSION], lastPane: PANE, known: [PANE, SESSION] });
  });

  it('drops the previous session of a restarted step until its new attempt records one', () => {
    const retry: StepRef = { kind: 'session', id: 'retry-session', label: 'Diagnose' };
    const events = [
      event('running', 'Diagnose', SESSION),
      event('failed', 'Diagnose'),
      // A fix loop starts the step again; its new session takes a moment to open.
      event('running', 'Diagnose'),
    ];
    expect(stepRefsFrom(events)).toEqual({ known: [SESSION] });
    expect(stepRefsFrom([...events, event('running', 'Diagnose', retry)])).toMatchObject({
      current: retry,
      running: [retry],
    });
  });

  it('replaces an interrupted indexed attempt without losing history or parallel refs', () => {
    const replacement = { kind: 'session', id: 'replacement' };
    const events = [
      event('running', 'Diagnose', SESSION),
      event('running', 'Install', PANE),
      { ...event('running', 'Diagnose'), index: 0 },
    ];
    expect(stepRefsFrom(events)).toEqual({ current: PANE, running: [PANE], lastPane: PANE, known: [SESSION, PANE] });
    const raw = [
      ...events,
      event('running', 'Diagnose', replacement),
      { ...event('running', 'Diagnose'), ref: { kind: 'session' } },
      { ...event('running', 'Diagnose'), index: 'invalid' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    expect(stepRefsFrom(parseWorkflowProgress(raw))).toEqual({
      current: replacement,
      running: [PANE, replacement],
      lastPane: PANE,
      known: [SESSION, PANE, replacement],
    });
  });

  it('keeps every running step of a parallel group, the latest-started one current', () => {
    const other: StepRef = { kind: 'session', id: 'other-session', label: 'Review' };
    const events = [
      event('running', 'Diagnose'),
      event('running', 'Review'),
      event('running', 'Diagnose', SESSION),
      event('running', 'Review', other),
    ];
    expect(stepRefsFrom(events)).toMatchObject({ current: other, running: [SESSION, other] });
    // A later step finishing leaves the earlier one running and current.
    expect(stepRefsFrom([...events, event('completed', 'Review')])).toMatchObject({
      current: SESSION,
      running: [SESSION],
    });
  });
});

describe('createStepPaneTerminal', () => {
  it('reads and types into the current step pane', async () => {
    const client = { capture: vi.fn(async () => 'one\ntwo\nthree\n'), input: vi.fn(async () => true) };
    const terminal = createStepPaneTerminal(facade(), deps({ current: PANE }, { paneClient: () => client }));

    expect(terminal.capabilities(IN_PROCESS)).toEqual({ readable: true, writable: true, resizable: false });
    await expect(terminal.screen(IN_PROCESS, { lines: 2 })).resolves.toEqual(['two', 'three']);
    await terminal.write(IN_PROCESS, 'y\r');
    expect(client.input).toHaveBeenCalledWith(PANE.id, 'y\r');
    await expect(terminal.resize(IN_PROCESS, 80, 24)).resolves.toBe(false);
  });

  it('falls back to the pane log when the running pane already closed', async () => {
    const terminal = createStepPaneTerminal(facade(), deps({ current: PANE, lastPane: PANE }));
    await expect(terminal.screen(IN_PROCESS, {})).resolves.toEqual(['first', 'second']);
    await expect(terminal.write(IN_PROCESS, 'x')).rejects.toThrow('closed');
  });

  it('points at the session while a customRun step runs', async () => {
    const terminal = createStepPaneTerminal(facade(), deps({ current: SESSION, lastPane: PANE }));
    expect(terminal.capabilities(IN_PROCESS)).toMatchObject({ readable: false, writable: false });
    await expect(terminal.screen(IN_PROCESS, {})).resolves.toEqual([expect.stringContaining('agent session')]);
  });

  it('shows the latest command output of an in-process run between steps and after it ends', async () => {
    const launcher = facade();
    const terminal = createStepPaneTerminal(launcher, deps({ lastPane: PANE }));
    expect(terminal.capabilities(IN_PROCESS)).toMatchObject({ readable: true, writable: false });
    await expect(terminal.screen(IN_PROCESS, { lines: 1 })).resolves.toEqual(['second']);
    await expect(terminal.resize(IN_PROCESS, 80, 24)).resolves.toBe(false);
    expect(launcher.screen).not.toHaveBeenCalled();
  });

  it('reports a pane whose log is gone', async () => {
    const terminal = createStepPaneTerminal(
      facade(),
      deps({ lastPane: PANE }, { paneLog: vi.fn(async () => undefined) }),
    );
    await expect(terminal.screen(IN_PROCESS, {})).resolves.toEqual(['The step pane has closed.']);
  });

  it('keeps the launcher terminal for runs delegated to one, or with no step ref', async () => {
    const launcher = facade();
    const delegated = createStepPaneTerminal(launcher, deps({ lastPane: PANE }));
    await expect(delegated.screen(DELEGATED, { lines: 10 })).resolves.toEqual(['launcher screen']);
    const plain = createStepPaneTerminal(launcher, deps({}));
    await plain.write(IN_PROCESS, 'x');
    expect(launcher.write).toHaveBeenCalledWith(IN_PROCESS_RECORD, 'x');
    await expect(plain.resize(IN_PROCESS, 80, 24)).resolves.toBe(true);
  });

  it('reads and types into the pane of the step a request names, not only the current one', async () => {
    const first: StepRef = { kind: 'pane', id: 'pane-first', label: 'First check' };
    const second: StepRef = { kind: 'pane', id: 'pane-second', label: 'Second check' };
    const client = {
      capture: vi.fn(async (target: string) => `${target} screen\n`),
      input: vi.fn(async () => true),
    };
    const terminal = createStepPaneTerminal(
      facade(),
      deps(
        { current: second, running: [first, second], lastPane: second, known: [first, second] },
        { paneClient: () => client },
      ),
    );
    const named = { record: IN_PROCESS_RECORD, step: first.id };

    await expect(terminal.screen(named, {})).resolves.toEqual(['pane-first screen']);
    await terminal.write(named, 'y');
    expect(client.input).toHaveBeenCalledWith('pane-first', 'y');
    await expect(terminal.screen(IN_PROCESS, {})).resolves.toEqual(['pane-second screen']);
  });

  it('shows a named step that finished from its log, read-only', async () => {
    const finished: StepRef = { kind: 'pane', id: 'pane-done', label: 'Done' };
    const terminal = createStepPaneTerminal(
      facade(),
      deps({ current: PANE, running: [PANE], known: [finished, PANE] }),
    );
    const named = { record: IN_PROCESS_RECORD, step: finished.id };

    expect(terminal.capabilities(named)).toMatchObject({ readable: true, writable: false });
    await expect(terminal.screen(named, {})).resolves.toEqual(['first', 'second']);
    await expect(terminal.write(named, 'x')).rejects.toThrow('closed');
  });
});
