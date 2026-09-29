import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runServer: vi.fn() }));
vi.mock('../../src/cli/server/run', () => ({ runServer: mocks.runServer }));

let originalExitCode: typeof process.exitCode;
beforeEach(() => {
  originalExitCode = process.exitCode;
  vi.resetModules();
  vi.useFakeTimers();
  mocks.runServer.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe('standalone server exit deadline', () => {
  it('allows cleanup to finish before arming the final unreferenced deadline', async () => {
    let finish!: (code: number) => void;
    mocks.runServer.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    await import('../../src/bin/serve');
    expect(timeout).not.toHaveBeenCalled();
    finish(0);
    await Promise.resolve();
    expect(process.exitCode).toBe(0);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 2_000);
    const timer = timeout.mock.results[0]?.value as ReturnType<typeof setTimeout>;
    expect(timer.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('also bounds startup failure after reporting the error', async () => {
    mocks.runServer.mockRejectedValue(new Error('fixture startup failed'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await import('../../src/bin/serve');
    await Promise.resolve();
    expect(stderr).toHaveBeenCalledWith('[doompi-server] fixture startup failed\n');
    expect(process.exitCode).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
