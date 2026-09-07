import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { runnerLogTab, RunnerLogPanel } from '../../src/web/components/RunnerLogPanel.tsx';
import { runnerRunsChannel, runners } from '../../src/web/stores/runnersStore.ts';
import type { RunnerRunView } from '../../src/types/webRunners.ts';

/**
 * The log panel, mounted.
 *
 * The host catches whatever a plugin surface throws and swaps in a fallback,
 * so a component that crashes is invisible outside a browser. Rendering is
 * static, so no effect runs: what these prove is that the first paint, the one
 * every reader sees before a single byte of log arrives, holds together.
 */

const run = (id: string): RunnerRunView =>
  ({
    id,
    name: id,
    command: 'sleep 180',
    cwd: '/workspace',
    state: 'running',
    pid: 4321,
    backend: 'rmux',
    interactive: false,
    startedAt: new Date(0).toISOString(),
    logPath: `/logs/${id}.log`,
  }) as unknown as RunnerRunView;

afterEach(() => runners.reset());

describe('the runner log tab', () => {
  it('names its tab after the runner, so two open logs stay apart', () => {
    const tab = runnerLogTab(run('build'));

    expect(tab.id).toBe('runner-log-build');
    expect(tab.label).toBe('log · build');
  });
});

describe('the runner log panel', () => {
  it('renders before any log has been read', () => {
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('build')] })!);
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnerLogPanel, { ...props, runId: 'build' });

    expect(rendered.error).toBeUndefined();
    // The body says it is still reading rather than claiming the log is empty,
    // which is the one thing a reader cannot tell apart on their own.
    expect(rendered.includes('reading…')).toBe(true);
  });

  it('shows the runner it is following, with its command and where it runs', () => {
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('build')] })!);
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnerLogPanel, { ...props, runId: 'build' });

    expect(rendered.includes('build')).toBe(true);
    expect(rendered.includes('sleep 180')).toBe(true);
    expect(rendered.includes('/workspace')).toBe(true);
  });

  it('renders a runner the session no longer lists, because its log outlives it', () => {
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnerLogPanel, { ...props, runId: 'gone' });

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('no longer listed')).toBe(true);
  });

  it('renders with nothing focused, the state an empty cockpit opens in', () => {
    const { props } = slotPropsFixture({ sessionId: null });

    const rendered = renderPlugin(RunnerLogPanel, { ...props, runId: 'build' });

    expect(rendered.error).toBeUndefined();
  });
});
