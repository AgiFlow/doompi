import { afterEach, describe, expect, it, vi } from 'vitest';

import { runServerRuntime } from '../../src/builders/server/runtime';
import { runServer } from '../../src/cli/server/run';

vi.mock('../../src/builders/server/runtime', () => ({ runServerRuntime: vi.fn() }));
vi.mock('../../src/cli/commands/sync/workflow', () => ({ runSync: vi.fn() }));
vi.mock('../../src/cli/harnessOptions', () => ({ resolveHarnessOptions: vi.fn() }));

describe('runServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops when its IPC parent disconnects', async () => {
    let runtimeSignal: AbortSignal | undefined;
    vi.mocked(runServerRuntime).mockImplementation(async (_options, context) => {
      runtimeSignal = context.signal;
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return 0;
    });
    const on = vi.spyOn(process, 'on');
    const off = vi.spyOn(process, 'off');

    const running = runServer(['--auth-token-file', '/tmp/doompi-test-token']);
    const registration = on.mock.calls.find(([event]) => event === 'disconnect');
    expect(registration).toBeDefined();
    const stop = registration?.[1] as () => void;

    stop();

    await expect(running).resolves.toBe(0);
    expect(runtimeSignal?.aborted).toBe(true);
    expect(off).toHaveBeenCalledWith('disconnect', stop);
  });
});
