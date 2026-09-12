import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchRunnerDialog } from '../../src/web/components/LaunchRunnerDialog';
import { RunnersActivitySection } from '../../src/web/components/RunnersActivitySection';
import { RunnersPanel } from '../../src/web/components/RunnersPanel';
import { RunnerShellPanel, runnerShellTab } from '../../src/web/components/RunnerShellPanel';
import { webPlugin as scopedWebPlugin } from '../../src/extensions/web';
const webPlugin = {
  id: scopedWebPlugin.id,
  ...scopedWebPlugin.global,
  ...scopedWebPlugin.workspace,
  ...scopedWebPlugin.session,
};
import { runnerRunsChannel, runners } from '../../src/web/stores/runnersStore';
import type { RunnerRunView } from '../../src/types/webRunners';

const run = (id: string, state: 'running' | 'completed'): RunnerRunView =>
  ({
    id,
    name: id,
    command: `pnpm ${id}`,
    cwd: '/workspace/repo',
    state,
    pid: 900,
    backend: 'rmux',
    interactive: false,
    startedAt: new Date(0).toISOString(),
    logPath: `/logs/${id}.log`,
  }) as unknown as RunnerRunView;

afterEach(() => runners.reset());

describe('the runners group tab', () => {
  it('is opened from the group name, which is what gives the dock its hover underline', () => {
    // The host renders a group carrying a transientTab as a button; without
    // one the name is a plain label and there is nothing to click.
    const group = webPlugin.activityGroups?.find((entry) => entry.name === 'runners');

    expect(group?.transientTab).toBeDefined();
    expect(group?.transientTab?.().id).toBe('runner-runs');
  });

  it('keeps the section under the same name, so the dock still renders it inside the group', () => {
    const group = webPlugin.activityGroups?.find((entry) => entry.name === 'runners');

    expect(webPlugin.activitySections?.map((section) => section.id)).toContain(group?.name);
  });
});

describe('the runners activity section', () => {
  it('offers a launch from an idle focused session, but not with nothing focused', () => {
    const focused = slotPropsFixture({ sessionId: 's1' });
    const idle = renderPlugin(RunnersActivitySection, focused.props);
    expect(idle.includes('idle')).toBe(true);
    expect(idle.includes('launch a runner')).toBe(true);

    const unfocused = slotPropsFixture({ sessionId: null });
    const empty = renderPlugin(RunnersActivitySection, unfocused.props);
    expect(empty.error).toBeUndefined();
    expect(empty.includes('launch a runner')).toBe(false);
  });

  it('lists only live runners with tty and pending-stop state', () => {
    runnerRunsChannel.apply(
      's1',
      runnerRunsChannel.parse({
        runs: [{ ...run('tty', 'running'), interactive: true }, run('plain', 'running'), run('finished', 'completed')],
      })!,
    );
    runners.update('s1', (current) => ({ ...current, stopRequested: ['tty'] }));
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnersActivitySection, props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('tty')).toBe(true);
    expect(rendered.includes('stopping…')).toBe(true);
    expect(rendered.includes('pnpm tty')).toBe(true);
    expect(rendered.includes('pnpm plain')).toBe(true);
    expect(rendered.html).toContain('data-stopping="false"');
    expect(rendered.includes('finished')).toBe(false);
    expect(rendered.html).toContain('data-stopping="true"');
  });
});
describe('the runners panel', () => {
  it('says nothing is running rather than showing an empty grid', () => {
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnersPanel, props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('nothing running')).toBe(true);
  });

  it('gives each running runner a card with its command and where it runs', () => {
    runnerRunsChannel.apply('s1', runnerRunsChannel.parse({ runs: [run('build', 'running')] })!);
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnersPanel, props);

    expect(rendered.includes('build')).toBe(true);
    expect(rendered.includes('pnpm build')).toBe(true);
    expect(rendered.includes('/workspace/repo')).toBe(true);
    expect(rendered.includes('1 running')).toBe(true);
  });

  it('leaves out a finished runner, because the panel answers what is happening', () => {
    runnerRunsChannel.apply(
      's1',
      runnerRunsChannel.parse({ runs: [run('build', 'running'), run('lint', 'completed')] })!,
    );
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnersPanel, props);

    expect(rendered.includes('pnpm build')).toBe(true);
    expect(rendered.includes('pnpm lint')).toBe(false);
  });

  it('offers a way to launch one, both in the header and from the empty state', () => {
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnersPanel, props);

    expect(rendered.html).toContain('runners-panel-launch');
    expect(rendered.includes('launch a runner')).toBe(true);
  });

  it('offers no launch control with nothing focused, because there is no session to send to', () => {
    const { props } = slotPropsFixture({ sessionId: null });

    const rendered = renderPlugin(RunnersPanel, props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).not.toContain('runners-panel-launch');
  });

  it('renders with nothing focused, the state an empty cockpit opens in', () => {
    const { props } = slotPropsFixture({ sessionId: null });

    const rendered = renderPlugin(RunnersPanel, props);

    expect(rendered.error).toBeUndefined();
  });
});

describe('the launch dialog', () => {
  it('constructs without throwing', () => {
    // Radix portals its content, so a static render produces no markup to read.
    // What the line actually says is pinned by the round-trip test instead.
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(LaunchRunnerDialog, {
      sessionId: 's1',
      sendSessionFrame: props.sendSessionFrame,
      onClose: () => undefined,
    });

    expect(rendered.error).toBeUndefined();
  });
});

describe('the attached shell', () => {
  it('is offered only for a runner that was started interactive', () => {
    runnerRunsChannel.apply(
      's1',
      runnerRunsChannel.parse({
        runs: [run('plain', 'running'), { ...run('tty', 'running'), interactive: true }],
      })!,
    );
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnersPanel, props);

    expect(rendered.html).toContain('runners-card-shell-tty');
    // A non-interactive run has no pane to type into.
    expect(rendered.html).not.toContain('runners-card-shell-plain');
  });

  it('names its tab after the runner, so two attached panes stay apart', () => {
    const tab = runnerShellTab({ ...run('tty', 'running'), interactive: true });

    expect(tab.id).toBe('runner-shell-tty');
    expect(tab.label).toBe('shell · tty');
  });

  it('renders while it is still attaching', () => {
    runnerRunsChannel.apply(
      's1',
      runnerRunsChannel.parse({ runs: [{ ...run('tty', 'running'), interactive: true }] })!,
    );
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(RunnerShellPanel, { ...props, runId: 'tty' });

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('attaching…')).toBe(true);
  });

  it('renders with nothing focused, the state an empty cockpit opens in', () => {
    const { props } = slotPropsFixture({ sessionId: null });

    const rendered = renderPlugin(RunnerShellPanel, { ...props, runId: 'tty' });

    expect(rendered.error).toBeUndefined();
  });
});
