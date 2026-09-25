import { execFile } from 'node:child_process';

import { resolveLogSinkPort } from '@agimon-ai/log-sink-mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureGlobalLogSink } from '../../src/builders/server/logSink';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('@agimon-ai/log-sink-mcp', () => ({ resolveLogSinkPort: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

const env = { HOME: '/home/test', LOG_SINK_INSTANCE: 'global' };
const endpoint = { port: 4132, host: '127.0.0.1', endpoint: 'http://127.0.0.1:4132' };

function completeStart(error: Error | null = null): void {
  vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
    (callback as (error: Error | null, stdout: string, stderr: string) => void)(error, '', '');
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
}

describe('global log sink startup', () => {
  it('attaches to a healthy global daemon without starting or stopping it', async () => {
    const notice = vi.fn();
    vi.mocked(resolveLogSinkPort).mockResolvedValue(endpoint);

    await ensureGlobalLogSink({ cwd: '/external/worktree/subdir', env, notice });

    expect(resolveLogSinkPort).toHaveBeenCalledWith({ env, healthCheck: true });
    expect(execFile).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it('runs the published CLI in HTTP-only global mode and waits for health', async () => {
    const notice = vi.fn();
    vi.mocked(resolveLogSinkPort).mockResolvedValueOnce(undefined).mockResolvedValue(endpoint);
    completeStart();

    await ensureGlobalLogSink({ cwd: '/external/worktree/subdir', env, notice });

    expect(execFile).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/log-sink-mcp\/dist\/cli\.mjs$/u), 'start', '--global', '--http-only'],
      expect.objectContaining({ cwd: '/external/worktree/subdir', env, timeout: 5_000 }),
      expect.any(Function),
    );
    expect(resolveLogSinkPort).toHaveBeenCalledTimes(2);
    expect(notice).not.toHaveBeenCalled();
  });

  it('reports a failed launch without choosing a workspace-local daemon', async () => {
    vi.useFakeTimers();
    const notice = vi.fn();
    vi.mocked(resolveLogSinkPort).mockResolvedValue(undefined);
    completeStart(new Error('cannot spawn'));

    const startup = ensureGlobalLogSink({ cwd: '/external/worktree/subdir', env, notice });
    await vi.advanceTimersByTimeAsync(5_000);
    await startup;

    expect(resolveLogSinkPort).toHaveBeenCalledWith({ env, healthCheck: true });
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('Global log sink unavailable: cannot spawn'));
  });
});
