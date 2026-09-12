import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BashToolMessage } from '../../src/web/components/BashToolMessage';
import { runnerRunsChannel, runners } from '../../src/web/stores/runnersStore';
import type { RunnerRunView } from '../../src/types/webRunners';

vi.mock('@agimon-ai/doompi-web-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agimon-ai/doompi-web-components')>();
  return {
    ...actual,
    MessageItem: ({
      children,
      expandable: _expandable,
      ...props
    }: ComponentProps<'div'> & { expandable?: boolean; children?: ReactNode | ((state: object) => ReactNode) }) => (
      <div {...props}>{typeof children === 'function' ? children({ expanded: true }) : children}</div>
    ),
    Button: ({ onClick, children, ...props }: ComponentProps<'button'>) => {
      onClick?.({ stopPropagation: vi.fn() } as never);
      return <button {...props}>{children}</button>;
    },
  };
});

const run = (exit?: RunnerRunView['exit']): RunnerRunView =>
  ({
    id: 'build',
    name: 'build',
    command: 'pnpm build',
    cwd: '/workspace',
    state: exit === undefined ? 'running' : 'completed',
    pid: 42,
    backend: 'rmux',
    interactive: false,
    startedAt: new Date(0).toISOString(),
    logPath: '/logs/build.log',
    exit,
  }) as RunnerRunView;

function props(overrides: Record<string, unknown> = {}) {
  const { props: slots } = slotPropsFixture({ sessionId: 's1' });
  return {
    ...slots,
    toolCallId: 'call-1',
    toolName: 'bash',
    args: { command: 'pnpm build', background: true, interactive: true, timeout: 10, name: 'build' },
    statuses: {},
    result: {
      content: [],
      details: {
        id: 'build',
        runner: 'build',
        promoted: true,
        logPath: '/logs/build.log',
        fileSize: 2048,
        lines: 2,
        exitCode: 0,
        tail: 'compiled\ndone',
      },
    },
    output: 'compiled\ndone',
    running: false,
    isError: false,
    ...overrides,
  } as Parameters<typeof BashToolMessage>[0];
}

afterEach(() => runners.reset());

describe('the bash timeline item', () => {
  it('shows the expanded command, output, result, log path, and controls for a promoted live runner', () => {
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run()] })!);

    const rendered = renderPlugin(BashToolMessage, props());

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('pnpm build')).toBe(true);
    expect(rendered.includes('background')).toBe(true);
    expect(rendered.includes('full log · /logs/build.log')).toBe(true);
    expect(rendered.html).toContain('tool-result-bash-open-log');
    expect(rendered.html).toContain('tool-result-bash-stop');
    expect(rendered.includes('bg · tty · 10s · build')).toBe(true);
  });

  it('marks a pending stop and omits controls when the runner or session is unavailable', () => {
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run()] })!);
    runners.update('s1', (current) => ({ ...current, stopRequested: ['build'] }));

    const stopping = renderPlugin(BashToolMessage, props());
    expect(stopping.includes('stopping…')).toBe(true);
    expect(stopping.html).toContain('data-stopping="true"');

    const unavailable = renderPlugin(
      BashToolMessage,
      props({ sessionId: null, args: { command: 4 }, result: null, output: '', running: true }),
    );
    expect(unavailable.error).toBeUndefined();
    expect(unavailable.html).not.toContain('tool-result-bash-open-log');
    expect(unavailable.html).not.toContain('tool-result-bash-stop');
    expect(unavailable.html).not.toContain('tool-result-bash-command');
    expect(unavailable.html).not.toContain('tool-result-bash-output');
  });

  it('renders an unsuccessful result without pretending it can still be stopped', () => {
    runnerRunsChannel.apply(
      's1',
      runnerRunsChannel.parse({
        runs: [run({ reason: 'signaled', code: null, signal: 'SIGTERM', finishedAt: new Date(1).toISOString() })],
      })!,
    );

    const rendered = renderPlugin(
      BashToolMessage,
      props({
        isError: true,
        result: { content: [], details: { id: 'build', promoted: true, exitCode: 1, reason: 'signal' } },
      }),
    );

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('compiled')).toBe(true);
    expect(rendered.includes('done')).toBe(true);
    expect(rendered.html).not.toContain('tool-result-bash-stop');
    expect(rendered.html).toContain('tool-result-bash-status');
  });
});
