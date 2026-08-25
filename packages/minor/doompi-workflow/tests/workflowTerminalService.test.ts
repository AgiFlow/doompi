import { describe, expect, it, vi } from 'vitest';
import { createWorkflowTerminalService, type TerminalPort } from '../src/services/workflowTerminal.ts';

interface Run {
  id: string;
}

const WRITABLE = { readable: true, writable: true, resizable: true };
const run: Run = { id: 'r1' };
const IDENTITY = 'repo/blog-writing-4';

function service(overrides: Partial<TerminalPort<Run>> = {}, now = () => 0) {
  const terminal: TerminalPort<Run> = {
    capabilities: () => WRITABLE,
    screen: vi.fn(() => Promise.resolve(['line'])),
    write: vi.fn(() => Promise.resolve()),
    resize: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
  return { terminal, api: createWorkflowTerminalService<Run>({ terminal, now, refreshMs: 750, leaseMs: 1000 }) };
}

describe('workflow terminal service: reading', () => {
  // Reading a pane forks a CLI. Several surfaces on one run would otherwise
  // each fork on their own timer.
  it('reads once for several callers inside the interval', async () => {
    let clock = 0;
    const { terminal, api } = service({}, () => clock);
    await api.screen(IDENTITY, run, 24);
    clock = 100;
    await api.screen(IDENTITY, run, 24);
    expect(terminal.screen).toHaveBeenCalledTimes(1);
  });

  it('reads again once the interval has passed', async () => {
    let clock = 0;
    const { terminal, api } = service({}, () => clock);
    await api.screen(IDENTITY, run, 24);
    clock = 5_000;
    await api.screen(IDENTITY, run, 24);
    expect(terminal.screen).toHaveBeenCalledTimes(2);
  });

  // A read that runs long must not have the next one start on top of it.
  it('answers a caller that arrives mid-read with the last screen', async () => {
    let release = (): void => undefined;
    const pending = new Promise<string[]>((resolve) => {
      release = () => resolve(['fresh']);
    });
    let clock = 0;
    const { terminal, api } = service({ screen: vi.fn(() => pending) }, () => clock);
    const first = api.screen(IDENTITY, run, 24);
    clock = 5_000;
    expect(await api.screen(IDENTITY, run, 24)).toEqual([]);
    release();
    expect(await first).toEqual(['fresh']);
    expect(terminal.screen).toHaveBeenCalledTimes(1);
  });

  it('forgets what it read for runs that can never change again', async () => {
    let clock = 0;
    const { terminal, api } = service({}, () => clock);
    await api.screen(IDENTITY, run, 24);
    api.forget(new Set());
    await api.screen(IDENTITY, run, 24);
    expect(terminal.screen).toHaveBeenCalledTimes(2);
  });
});

describe('workflow terminal service: the keyboard', () => {
  it('lets the holder write and renews the lease as it goes', async () => {
    const { terminal, api } = service();
    expect(api.takeControl(IDENTITY, 'mine')).toBe(true);
    await api.write(IDENTITY, run, 'mine', 'y');
    expect(terminal.write).toHaveBeenCalledWith(run, 'y');
  });

  it('refuses a second holder while the first still has it', () => {
    const { api } = service();
    expect(api.takeControl(IDENTITY, 'first')).toBe(true);
    expect(api.takeControl(IDENTITY, 'second')).toBe(false);
  });

  it('refuses a write that carries someone else lease', async () => {
    const { terminal, api } = service();
    api.takeControl(IDENTITY, 'first');
    await expect(api.write(IDENTITY, run, 'second', 'y')).rejects.toThrow('Another reader holds the keyboard');
    expect(terminal.write).not.toHaveBeenCalled();
  });

  // A tab that closed without releasing must not lock the run out forever.
  it('hands the keyboard on once an abandoned lease expires', () => {
    let clock = 0;
    const { api } = service({}, () => clock);
    api.takeControl(IDENTITY, 'gone');
    clock = 10_000;
    expect(api.takeControl(IDENTITY, 'next')).toBe(true);
  });

  it('gives the keyboard back on release', () => {
    const { api } = service();
    api.takeControl(IDENTITY, 'first');
    api.releaseControl(IDENTITY, 'first');
    expect(api.takeControl(IDENTITY, 'second')).toBe(true);
  });

  it('ignores a release from someone who does not hold it', () => {
    const { api } = service();
    api.takeControl(IDENTITY, 'first');
    api.releaseControl(IDENTITY, 'impostor');
    expect(api.takeControl(IDENTITY, 'second')).toBe(false);
  });

  // Geometry is shared by everyone watching, so a passive reader must not
  // reflow the screen under the person typing.
  it('resizes only for the holder', async () => {
    const { terminal, api } = service();
    api.takeControl(IDENTITY, 'mine');
    expect(await api.resize(IDENTITY, run, 'mine', 120, 32)).toBe(true);
    await expect(api.resize(IDENTITY, run, 'theirs', 80, 24)).rejects.toThrow('Another reader holds the keyboard');
    expect(terminal.resize).toHaveBeenCalledTimes(1);
  });

  it('reports what the run allows', () => {
    const capabilities = { readable: false, writable: false, resizable: false, reason: 'hosted natively' };
    const { api } = service({ capabilities: () => capabilities });
    expect(api.capabilities(run)).toEqual(capabilities);
  });
});
