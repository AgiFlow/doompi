import { execFile } from 'node:child_process';
import os from 'node:os';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runServerRuntime } from '../../src/builders/server/runtime';
import { runServer } from '../../src/cli/server/run';
import { readSyncDrift } from '../../src/composition/syncDrift';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../src/builders/server/runtime', () => ({ runServerRuntime: vi.fn() }));
vi.mock('../../src/composition/syncDrift', () => ({ readSyncDrift: vi.fn() }));
vi.mock('../../src/cli/harnessOptions', () => ({ resolveHarnessOptions: vi.fn() }));

describe('runServer', () => {
  beforeEach(() => {
    vi.mocked(readSyncDrift).mockReturnValue({ fresh: true, reasons: [] });
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      const complete = callback as unknown as (error: Error | null, stdout: string, stderr: string) => void;
      complete(null, '', '');
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs stale sync work outside the headless server process', async () => {
    vi.mocked(readSyncDrift).mockReturnValue({ fresh: false, reasons: ['never-synced'] });
    vi.mocked(runServerRuntime).mockResolvedValue(0);
    let finishSync: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      finishSync = callback as typeof finishSync;
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);

    const running = runServer(['--auth-token-file', '/tmp/doompi-test-token']);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledOnce());

    expect(runServerRuntime).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        '--input-type=module',
        '--eval',
        expect.any(String),
        expect.stringContaining('/sync/workflow.'),
      ]),
      expect.objectContaining({
        cwd: globalDoomConfigDirectory(process.env.HOME ?? os.homedir()),
        env: expect.objectContaining({ DOOMPI_ROOT: globalDoomConfigDirectory(process.env.HOME ?? os.homedir()) }),
        encoding: 'utf8',
      }),
      expect.any(Function),
    );

    finishSync?.(null, '', '');
    await expect(running).resolves.toBe(0);
    expect(runServerRuntime).toHaveBeenCalledOnce();
  });

  it('synchronizes changed worktree sources before admitting a session', async () => {
    vi.mocked(readSyncDrift).mockImplementation(({ requireFreshSources }) => ({
      fresh: requireFreshSources !== true,
      reasons: requireFreshSources ? ['mcp-bundle-stale'] : [],
    }));
    vi.mocked(runServerRuntime).mockImplementation(async (_options, context) => {
      await context.syncWorkspace('/worktree', { HOME: '/home' }, true);
      return 0;
    });

    await expect(runServer(['--auth-token-file', '/tmp/doompi-test-token'])).resolves.toBe(0);
    expect(readSyncDrift).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: '/worktree', requireFreshSources: true }),
    );
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({ cwd: '/worktree' }),
      expect.any(Function),
    );
  });

  it('leaves unchanged worktree artifacts alone', async () => {
    vi.mocked(runServerRuntime).mockImplementation(async (_options, context) => {
      await context.syncWorkspace('/worktree', { HOME: '/home' }, true);
      return 0;
    });

    await expect(runServer(['--auth-token-file', '/tmp/doompi-test-token'])).resolves.toBe(0);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('does not admit a session when worktree synchronization fails', async () => {
    vi.mocked(readSyncDrift).mockImplementation(({ requireFreshSources }) => ({
      fresh: requireFreshSources !== true,
      reasons: requireFreshSources ? ['mcp-bundle-stale'] : [],
    }));
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      (callback as (error: Error, stdout: string, stderr: string) => void)(new Error('sync failed'), '', 'sync failed');
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);
    vi.mocked(runServerRuntime).mockImplementation(async (_options, context) => {
      await context.syncWorkspace('/worktree', { HOME: '/home' }, true);
      return 0;
    });

    await expect(runServer(['--auth-token-file', '/tmp/doompi-test-token'])).rejects.toThrow('sync failed');
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
