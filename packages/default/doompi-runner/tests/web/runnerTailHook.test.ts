import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRunnerLog, followRunnerLog } from '../../src/web/api/logApi';
import { useRunnerTail } from '../../src/web/hooks/runnerTail';

const setTail = vi.fn();
let cleanup: (() => void) | undefined;

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: () => [undefined, setTail],
    useEffect: (effect: () => void | (() => void)) => {
      cleanup = effect() ?? undefined;
    },
  };
});

vi.mock('../../src/web/api/logApi', () => ({
  fetchRunnerLog: vi.fn(),
  followRunnerLog: vi.fn(),
}));

const fetchLog = vi.mocked(fetchRunnerLog);
const followLog = vi.mocked(followRunnerLog);

beforeEach(() => {
  vi.clearAllMocks();
  cleanup = undefined;
});

afterEach(() => cleanup?.());

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('the runner tail subscription', () => {
  it('does nothing for a finished runner or an unfocused session', () => {
    expect(useRunnerTail('s1', 'run', false)).toBeUndefined();
    expect(useRunnerTail(null, 'run', true)).toBeUndefined();
    expect(fetchLog).not.toHaveBeenCalled();
  });

  it('keeps a useful initial line without following a finished log slice', async () => {
    fetchLog.mockResolvedValue({
      slice: {
        runId: 'run',
        path: '/tmp/run.log',
        text: 'first\nlast\n',
        exists: true,
        running: false,
        completeBytes: 11,
        fileSize: 11,
        totalLines: 2,
        lineCount: 2,
      },
    });

    useRunnerTail('s1', 'run', true);
    await settle();

    expect(setTail).toHaveBeenCalledWith({ runId: 'run', text: 'last' });
    expect(followLog).not.toHaveBeenCalled();
  });

  it('follows a running slice, accepts useful frames, and closes on cleanup', async () => {
    const close = vi.fn();
    followLog.mockReturnValue({ close });
    fetchLog.mockResolvedValue({
      slice: {
        runId: 'run',
        path: '/tmp/run.log',
        text: '',
        exists: true,
        running: true,
        completeBytes: 4,
        fileSize: 4,
        totalLines: 0,
        lineCount: 0,
      },
    });

    useRunnerTail('s1', 'run', true);
    await settle();
    const handlers = followLog.mock.calls[0]![3];
    handlers.onEvent({ lines: ['', 'next'], offset: 8 });
    handlers.onEvent({ lines: [''], offset: 9 });
    cleanup?.();

    expect(setTail).toHaveBeenCalledWith({ runId: 'run', text: 'next' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('ignores hub errors and results or frames delivered after cleanup', async () => {
    fetchLog.mockResolvedValueOnce({ error: 'offline' });
    useRunnerTail('s1', 'error-run', true);
    await settle();
    expect(followLog).not.toHaveBeenCalled();

    let resolve!: (value: Awaited<ReturnType<typeof fetchRunnerLog>>) => void;
    fetchLog.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    useRunnerTail('s1', 'late-run', true);
    cleanup?.();
    resolve({
      slice: {
        runId: 'late-run',
        path: '/tmp/late-run.log',
        text: 'late',
        exists: true,
        running: true,
        completeBytes: 4,
        fileSize: 4,
        totalLines: 1,
        lineCount: 1,
      },
    });
    await settle();

    expect(setTail).not.toHaveBeenCalled();
    expect(followLog).not.toHaveBeenCalled();
  });
});
