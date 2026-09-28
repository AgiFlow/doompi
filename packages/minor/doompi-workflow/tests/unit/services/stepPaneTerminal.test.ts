import type { WorkflowProgressEvent, WorkflowRunRecord } from '@agimon-ai/workflow-mcp';
import { describe, expect, it, vi } from 'vitest';

import { createStepPaneTerminal, stepRefsFrom } from '../../../src/services/stepPaneTerminal';
import type { RunStepRefs, StepPaneTerminalDependencies, StepRef } from '../../../src/services/stepPaneTerminal/type';
import type { TerminalPort } from '../../../src/services/workflowTerminal';

const PANE: StepRef = { kind: 'pane', id: 'doom-runner-workflow-1', label: 'Install' };
const SESSION: StepRef = { kind: 'session', id: 'child-session', label: 'Diagnose' };
const IN_PROCESS = {
  runKey: 'r1',
  workspace: 'w',
  stage: 'running',
  workflowPath: '/repo/wf.yml',
  launcher: { type: 'native', pid: 42 },
} as WorkflowRunRecord;
const DELEGATED = { ...IN_PROCESS, launcher: { type: 'tmux', sessionName: 'wf' } } as WorkflowRunRecord;

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
      lastPane: PANE,
    });
    expect(stepRefsFrom([event('running', 'Install', PANE), event('completed', 'Install')])).toEqual({
      lastPane: PANE,
    });
    expect(
      stepRefsFrom([
        event('running', 'Install', PANE),
        event('completed', 'Install'),
        event('running', 'Diagnose'),
        event('running', 'Diagnose', SESSION),
      ]),
    ).toEqual({ current: SESSION, lastPane: PANE });
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
    expect(launcher.write).toHaveBeenCalledWith(IN_PROCESS, 'x');
    await expect(plain.resize(IN_PROCESS, 80, 24)).resolves.toBe(true);
  });
});
