import os from 'node:os';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runServerRuntime } from '../../src/builders/server/runtime';
import { runSync } from '../../src/cli/commands/sync/workflow';
import { runServer } from '../../src/cli/server/run';
import { readSyncDrift } from '../../src/composition/syncDrift';

vi.mock('../../src/builders/server/runtime', () => ({ runServerRuntime: vi.fn() }));
vi.mock('../../src/composition/syncDrift', () => ({ readSyncDrift: vi.fn() }));
vi.mock('../../src/cli/commands/sync/workflow', () => ({ runSync: vi.fn() }));
vi.mock('../../src/cli/harnessOptions', () => ({ resolveHarnessOptions: vi.fn() }));

describe('runServer', () => {
  beforeEach(() => {
    vi.mocked(readSyncDrift).mockReturnValue({ fresh: true, reasons: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncs the global runtime before starting the headless server', async () => {
    vi.mocked(readSyncDrift).mockReturnValue({ fresh: false, reasons: ['never-synced'] });
    vi.mocked(runSync).mockResolvedValue(0);
    vi.mocked(runServerRuntime).mockResolvedValue(0);

    await expect(runServer(['--auth-token-file', '/tmp/doompi-test-token'])).resolves.toBe(0);

    expect(runSync).toHaveBeenCalledWith(
      ['sync', '--global'],
      expect.objectContaining({ DOOMPI_ROOT: globalDoomConfigDirectory(process.env.HOME ?? os.homedir()) }),
      globalDoomConfigDirectory(process.env.HOME ?? os.homedir()),
      expect.objectContaining({ write: expect.any(Function) }),
    );
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
    await vi.waitFor(() => expect(runServerRuntime).toHaveBeenCalled());
    const registration = on.mock.calls.filter(([event]) => event === 'disconnect').at(-1);
    expect(registration).toBeDefined();
    const stop = registration?.[1] as () => void;

    stop();

    await expect(running).resolves.toBe(0);
    expect(runtimeSignal?.aborted).toBe(true);
    expect(off).toHaveBeenCalledWith('disconnect', stop);
  });
});
