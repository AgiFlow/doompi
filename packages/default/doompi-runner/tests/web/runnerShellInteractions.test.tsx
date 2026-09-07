import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunnerShellPanel } from '../../src/web/components/RunnerShellPanel.tsx';
import { runnerRunsChannel, runners } from '../../src/web/stores/runnersStore.ts';
import type { RunnerRunView } from '../../src/types/webRunners.ts';
import { sendRunnerInput } from '../../src/web/api/screenApi.ts';

vi.mock('../../src/web/api/screenApi.ts', () => ({
  decodeChunk: vi.fn(),
  sendRunnerInput: vi.fn().mockResolvedValue(true),
  watchRunnerScreen: vi.fn(),
}));

vi.mock('@agimon-ai/doompi-web-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agimon-ai/doompi-web-components')>();
  return {
    ...actual,
    Button: ({ onClick, children, ...props }: ComponentProps<'button'>) => {
      onClick?.({} as never);
      return <button {...props}>{children}</button>;
    },
    TerminalView: ({ onData, onReady, ...props }: { onData: (text: string) => void; onReady: () => void }) => {
      onData('a');
      onData('b');
      onReady();
      return <div {...props} />;
    },
  };
});

const run: RunnerRunView = {
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
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  runners.reset();
});

describe('the attached shell controls', () => {
  it('batches ctrl-c and terminal data in dispatch order', async () => {
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run] })!);
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnerShellPanel, { ...props, runId: 'tty' });
    await vi.runAllTimersAsync();

    expect(rendered.error).toBeUndefined();
    expect(sendRunnerInput).toHaveBeenCalledWith('s1', 'tty', '\u0003ab');
  });

  it('does not send terminal input without a focused session', async () => {
    const { props } = slotPropsFixture({ sessionId: null });

    const rendered = renderPlugin(RunnerShellPanel, { ...props, runId: 'tty' });
    await vi.runAllTimersAsync();

    expect(rendered.error).toBeUndefined();
    expect(sendRunnerInput).not.toHaveBeenCalled();
  });
});
