import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAlive, stopSession } from '../../../../src/services/sessionStop';

const UNREACHABLE_PID = 0x7ffffffe;

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Replaces process.kill so signal delivery is decided by the test, not the OS. */
function stubKill(behaviour: (signal: string | number | undefined) => void) {
  return vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    behaviour(signal);
    return true;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isAlive', () => {
  it('is true for this very process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('is false for a pid that cannot exist', () => {
    expect(isAlive(UNREACHABLE_PID)).toBe(false);
  });

  it('is false for a pid that is not a pid, without signalling a process group', () => {
    // Signal 0 to pid 0 addresses this process's whole group, so the guard is
    // what stops a liveness check from becoming a broadcast.
    const kill = stubKill(() => undefined);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('treats EPERM as alive, because someone else owns the process', () => {
    stubKill(() => {
      throw errno('EPERM');
    });
    expect(isAlive(4242)).toBe(true);
  });

  it('treats ESRCH as gone', () => {
    stubKill(() => {
      throw errno('ESRCH');
    });
    expect(isAlive(4242)).toBe(false);
  });
});

describe('stopSession', () => {
  it('returns true immediately when the process is already dead', async () => {
    const kill = stubKill((signal) => {
      if (signal === 0) throw errno('ESRCH');
    });
    await expect(stopSession(UNREACHABLE_PID, 5000)).resolves.toBe(true);
    expect(kill.mock.calls.map((call) => call[1])).toEqual([0]);
  });

  it('returns true when the process exits between the check and the signal', async () => {
    stubKill((signal) => {
      if (signal === 'SIGTERM') throw errno('ESRCH');
    });
    await expect(stopSession(4242, 5000)).resolves.toBe(true);
  });

  it('returns true once the process stops answering, having sent only SIGTERM', async () => {
    let alive = true;
    const kill = stubKill((signal) => {
      if (signal === 0 && !alive) throw errno('ESRCH');
      if (signal === 'SIGTERM') alive = false;
    });
    const clock = fakeClock();

    await expect(stopSession(4242, 5000, clock.now, clock.sleep)).resolves.toBe(true);
    expect(kill.mock.calls.map((call) => call[1])).toEqual([0, 'SIGTERM', 0]);
  });

  it('returns false on timeout and never escalates to SIGKILL', async () => {
    // Killing a session that is slow to flush is the caller's decision, so a
    // timeout here has to stay a report rather than become a second signal.
    const kill = stubKill(() => undefined);
    const clock = fakeClock();

    await expect(stopSession(4242, 500, clock.now, clock.sleep)).resolves.toBe(false);
    expect(kill.mock.calls.map((call) => call[1])).not.toContain('SIGKILL');
    expect(clock.slept.length).toBeGreaterThan(0);
    expect(clock.slept.every((ms) => ms === 100)).toBe(true);
  });
});

/** A clock that only advances when the code under test sleeps. */
function fakeClock() {
  let time = 1000;
  const slept: number[] = [];
  return {
    now: () => time,
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      time += ms;
      return Promise.resolve();
    },
  };
}
