import { describe, expect, it, vi } from 'vitest';
import { PtyBackendChain } from '../../src/adapters/PtyBackendChain/PtyBackendChain.ts';
import type { RunHandle } from '../../src/types/launcher';
import type { PtyRun } from '../../src/types/ptyHost';
import type { IRmuxBackend } from '../../src/types/rmuxBackend';

function handleFor(backend: 'rmux' | 'tmux'): RunHandle {
  return {
    id: 'run-1',
    name: 'run',
    pid: 100,
    logPath: '/logs/run-1.log',
    backend,
    backendTarget: backend === 'tmux' ? 'doom-tmux-run-1' : 'doom-runner-run-1',
    output: () => '',
    completion: () => Promise.resolve({ code: 0, signal: null }),
    detach: () => undefined,
    stop: () => Promise.resolve(true),
  };
}

function fakeBackend(overrides: Partial<IRmuxBackend> = {}): IRmuxBackend {
  return {
    launch: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(false),
    input: vi.fn().mockResolvedValue(false),
    readOutcome: vi.fn().mockReturnValue(undefined),
    get: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

describe('PtyBackendChain', () => {
  it('prefers rmux for a launch it accepts', async () => {
    const rmux = fakeBackend({ launch: vi.fn().mockResolvedValue(handleFor('rmux')) });
    const tmux = fakeBackend();
    const chain = new PtyBackendChain(rmux, tmux);

    const handle = await chain.launch({
      id: 'run-1',
      name: 'run',
      command: 'echo hi',
      cwd: '/repo',
      sessionId: 'session-1',
      interactive: false,
    });

    expect(handle?.backend).toBe('rmux');
    expect(tmux.launch).not.toHaveBeenCalled();
  });

  it('falls through to tmux when rmux declines', async () => {
    const rmux = fakeBackend();
    const tmux = fakeBackend({ launch: vi.fn().mockResolvedValue(handleFor('tmux')) });
    const chain = new PtyBackendChain(rmux, tmux);

    const handle = await chain.launch({
      id: 'run-1',
      name: 'run',
      command: 'echo hi',
      cwd: '/repo',
      sessionId: 'session-1',
      interactive: false,
    });

    expect(handle?.backend).toBe('tmux');
  });

  it('answers undefined when no backend accepts the launch', async () => {
    const chain = new PtyBackendChain(fakeBackend(), fakeBackend());

    await expect(
      chain.launch({
        id: 'run-1',
        name: 'run',
        command: 'echo hi',
        cwd: '/repo',
        sessionId: 'session-1',
        interactive: false,
      }),
    ).resolves.toBeUndefined();
  });

  it('routes a tmux target to tmux and never to rmux', async () => {
    const rmux = fakeBackend();
    const tmux = fakeBackend({ stop: vi.fn().mockResolvedValue(true), input: vi.fn().mockResolvedValue(true) });
    const chain = new PtyBackendChain(rmux, tmux);

    await expect(chain.stop('doom-tmux-run-1', 100)).resolves.toBe(true);
    await expect(chain.input('doom-tmux-run-1', 'text')).resolves.toBe(true);
    await chain.watch('run-1', 'doom-tmux-run-1', 'session-1');

    expect(tmux.stop).toHaveBeenCalledWith('doom-tmux-run-1', 100);
    expect(rmux.stop).not.toHaveBeenCalled();
    expect(rmux.input).not.toHaveBeenCalled();
    expect(rmux.watch).not.toHaveBeenCalled();
  });

  it('routes an rmux target to rmux and never to tmux', async () => {
    const rmux = fakeBackend({ stop: vi.fn().mockResolvedValue(true) });
    const tmux = fakeBackend();
    const chain = new PtyBackendChain(rmux, tmux);

    await expect(chain.stop('doom-runner-run-1', 100)).resolves.toBe(true);
    await chain.input('doom-runner-run-1', 'text');

    expect(rmux.stop).toHaveBeenCalledWith('doom-runner-run-1', 100);
    expect(tmux.stop).not.toHaveBeenCalled();
    expect(tmux.input).not.toHaveBeenCalled();
  });

  it('reads terminal evidence and live runs from whichever backend holds them', () => {
    const run = { name: 'run' } as unknown as PtyRun;
    const rmux = fakeBackend();
    const tmux = fakeBackend({
      readOutcome: vi.fn().mockReturnValue({ code: 3, signal: null }),
      get: vi.fn().mockReturnValue(run),
    });
    const chain = new PtyBackendChain(rmux, tmux);

    expect(chain.readOutcome('run-1', 'session-1')).toEqual({ code: 3, signal: null });
    expect(chain.get('run')).toBe(run);
  });
});
