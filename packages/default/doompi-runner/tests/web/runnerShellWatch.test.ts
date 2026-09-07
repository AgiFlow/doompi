import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeChunk, watchRunnerScreen } from '../../src/web/api/screenApi.ts';
import { RunnerShellPanel } from '../../src/web/components/RunnerShellPanel.tsx';
import { runnerRunsChannel, runners } from '../../src/web/stores/runnersStore.ts';
import type { RunnerRunView } from '../../src/types/webRunners.ts';

const setEnded = vi.fn();
const setLost = vi.fn();
const terminalWrite = vi.fn();
const cleanups: Array<() => void> = [];
let stateIndex = 0;
let refIndex = 0;

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: () => {
      const index = stateIndex++;
      return index === 0 ? [false, setEnded] : index === 1 ? [false, setLost] : [true, vi.fn()];
    },
    useRef: () => {
      const index = refIndex++;
      if (index === 0) return { current: { write: terminalWrite } };
      if (index === 1) return { current: [] };
      return { current: undefined };
    },
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    },
  };
});

vi.mock('@tanstack/react-store', () => ({
  useStore: (store: { state: unknown }, selector: (state: unknown) => unknown) => selector(store.state),
}));

vi.mock('../../src/web/api/screenApi.ts', () => ({
  decodeChunk: vi.fn(() => new Uint8Array([65])),
  sendRunnerInput: vi.fn(),
  watchRunnerScreen: vi.fn(),
}));

const run = {
  id: 'tty',
  name: 'tty',
  command: 'shell',
  cwd: '/workspace',
  state: 'running',
  pid: 42,
  backend: 'rmux',
  interactive: true,
  startedAt: new Date(0).toISOString(),
  logPath: '/logs/tty.log',
} as RunnerRunView;

beforeEach(() => {
  vi.clearAllMocks();
  runners.reset();
  stateIndex = 0;
  refIndex = 0;
  cleanups.length = 0;
});

describe('the attached shell stream', () => {
  it('writes nonempty frames, records end and loss, and closes the stream', () => {
    const close = vi.fn();
    vi.mocked(watchRunnerScreen).mockReturnValue({ close });
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run] })!);

    RunnerShellPanel({ sessionId: 's1', runId: 'tty' } as Parameters<typeof RunnerShellPanel>[0]);
    const handlers = vi.mocked(watchRunnerScreen).mock.calls[0]![3];
    handlers.onEvent({ chunk: '', offset: 1 });
    handlers.onEvent({ chunk: 'QQ==', offset: 2, ended: true });
    handlers.onLost();
    cleanups.forEach((cleanup) => cleanup());

    expect(decodeChunk).toHaveBeenCalledWith('QQ==');
    expect(terminalWrite).toHaveBeenCalledWith(new Uint8Array([65]));
    expect(setEnded).toHaveBeenCalledWith(true);
    expect(setLost).toHaveBeenCalledWith(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not open a stream without a focused session', () => {
    RunnerShellPanel({ sessionId: null, runId: 'tty' } as Parameters<typeof RunnerShellPanel>[0]);
    expect(watchRunnerScreen).not.toHaveBeenCalled();
  });
});
