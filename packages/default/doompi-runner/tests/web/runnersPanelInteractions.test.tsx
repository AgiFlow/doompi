import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerRunView } from '../../src/types/webRunners.ts';
import { RunnersPanel } from '../../src/web/components/RunnersPanel.tsx';
import { runnerRunsChannel, runners } from '../../src/web/stores/runnersStore.ts';

const interaction = vi.hoisted(() => ({ targets: new Set<string>() }));

vi.mock('@agimon-ai/doompi-web-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agimon-ai/doompi-web-components')>();
  const activate = (testId: unknown, handler: (() => void) | undefined): void => {
    if (typeof testId === 'string' && interaction.targets.delete(testId)) handler?.();
  };
  return {
    ...actual,
    Button: ({
      onClick,
      children,
      'data-testid': testId,
      ...props
    }: ComponentProps<'button'> & { 'data-testid'?: string }) => {
      activate(testId, onClick as (() => void) | undefined);
      return (
        <button data-testid={testId} {...props}>
          {children}
        </button>
      );
    },
    DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: ({
      onSelect,
      children,
      'data-testid': testId,
      ...props
    }: {
      onSelect?: () => void;
      children: ReactNode;
      'data-testid'?: string;
    }) => {
      activate(testId, onSelect);
      return (
        <div data-testid={testId} {...props}>
          {children}
        </div>
      );
    },
  };
});

vi.mock('../../src/web/components/LaunchRunnerDialog.tsx', () => ({
  LaunchRunnerDialog: ({ defaultCwd }: { defaultCwd?: string }) => (
    <div data-testid="launch-dialog" data-default-cwd={defaultCwd ?? ''} />
  ),
}));

vi.mock('../../src/web/hooks/runnerTail.ts', () => ({
  useRunnerTail: () => 'latest output',
}));

const run = (id: string, interactive = false): RunnerRunView =>
  ({
    id,
    name: id,
    command: `pnpm ${id}`,
    cwd: '/workspace/repo',
    state: 'running',
    pid: 900,
    backend: 'rmux',
    interactive,
    startedAt: new Date(0).toISOString(),
    logPath: `/logs/${id}.log`,
  }) as RunnerRunView;

beforeEach(() => {
  interaction.targets.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  runners.reset();
});

describe('the runners panel controls', () => {
  it('starts a shell through the launch menu', () => {
    interaction.targets.add('runners-panel-start-shell');
    const fixture = slotPropsFixture({ sessionId: 's1' });
    const sendSessionFrame = vi.fn();

    const rendered = renderPlugin(RunnersPanel, { ...fixture.props, sendSessionFrame });

    expect(rendered.error).toBeUndefined();
    expect(sendSessionFrame).toHaveBeenCalledOnce();
  });

  it.each([
    ['runners-panel-run-command', [run('build')]],
    ['runners-panel-launch-empty', []],
  ])('accepts the %s command-launch control', (target, runs) => {
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs })!);
    interaction.targets.add(target);
    const fixture = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnersPanel, fixture.props);

    expect(rendered.error).toBeUndefined();
    expect(interaction.targets).not.toContain(target);
  });

  it('opens log and shell tabs from an interactive runner', () => {
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('tty', true)] })!);
    interaction.targets.add('runners-card-log-tty');
    interaction.targets.add('runners-card-shell-tty');
    const fixture = slotPropsFixture({ sessionId: 's1' });
    const openTransientTab = vi.fn();

    const rendered = renderPlugin(RunnersPanel, { ...fixture.props, openTransientTab });

    expect(rendered.includes('latest output')).toBe(true);
    expect(openTransientTab).toHaveBeenCalledTimes(2);
  });

  it('requests a stop once and disables a repeated request', () => {
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('build')] })!);
    interaction.targets.add('runners-card-stop-build');
    const fixture = slotPropsFixture({ sessionId: 's1' });
    const sendSessionFrame = vi.fn();

    const rendered = renderPlugin(RunnersPanel, { ...fixture.props, sendSessionFrame });

    expect(rendered.error).toBeUndefined();
    expect(sendSessionFrame).toHaveBeenCalledOnce();
  });
});
