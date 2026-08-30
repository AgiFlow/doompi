import {
  driveChannel,
  renderPlugin,
  slotPropsFixture,
  toolMessagePropsFixture,
} from '@agimon-ai/doompi-web-contracts/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { workflows } from '../../web/workflowsStore.ts';
import { webPlugin } from '../../web/index.ts';

/**
 * Every surface this plugin declares, rendered at least once.
 *
 * The host routes to these by name and catches whatever they throw, replacing
 * the row with a fallback. That makes a broken component invisible outside a
 * browser, and the browser suite is the only thing that has ever mounted one.
 */

const run = {
  runKey: 'blog-writing-4',
  displayName: 'blog-writing',
  stage: 'running',
  startedAt: new Date(0).toISOString(),
  workspace: 'repo',
};

afterEach(() => workflows.reset());

describe('the workflows plugin surfaces', () => {
  it('renders the tab panel for a focused session with no runs', () => {
    const tab = webPlugin.tabs?.[0];
    const { props } = slotPropsFixture({ sessionId: 's1' });

    const rendered = renderPlugin(tab!.panel, props);

    // The empty session is the first thing anyone sees, and the state a panel
    // is most likely to index into something absent.
    expect(rendered.error).toBeUndefined();
    expect(tab?.id).toBe('workflows');
  });

  it('renders the tab panel with runs the hub reported', () => {
    const channel = webPlugin.channels?.find((candidate) => candidate.channel === 'workflow_runs');
    expect(driveChannel(channel!, 's1', { runs: [run] })).toEqual({ accepted: true });

    const rendered = renderPlugin(webPlugin.tabs![0]!.panel, slotPropsFixture({ sessionId: 's1' }).props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('blog-writing')).toBe(true);
  });

  it('keeps the idle activity section available as a workflow launcher', () => {
    const group = webPlugin.activityGroups?.[0];
    const section = webPlugin.activitySections?.[0];
    const rendered = renderPlugin(section!.component, slotPropsFixture({ sessionId: 's1' }).props);

    expect(group?.activeSource?.isActive('s1')).toBe(false);
    expect(section?.id).toBe('workflows');
    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('no runs yet')).toBe(true);
    expect(rendered.includes('launch a workflow')).toBe(true);
  });

  it('renders the activity section with a run reported by the hub', () => {
    const section = webPlugin.activitySections?.[0];
    driveChannel(webPlugin.channels![0]!, 's1', { runs: [run] });

    const rendered = renderPlugin(section!.component, slotPropsFixture({ sessionId: 's1' }).props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('blog-writing')).toBe(true);
    expect(webPlugin.activityGroups?.[0]?.activeSource?.isActive('s1')).toBe(true);
  });

  it('renders every surface with nothing focused', () => {
    // The host holds sessionId null before anything is focused and after the
    // last session closes, and every component is mounted in both states.
    const { props } = slotPropsFixture({ sessionId: null });

    for (const surface of [...(webPlugin.tabs ?? []), ...(webPlugin.activitySections ?? [])]) {
      const component = 'panel' in surface ? surface.panel : surface.component;
      const id = 'id' in surface ? surface.id : 'unknown';
      expect(renderPlugin(component, props).error, id).toBeUndefined();
    }
  });

  it('renders every tool it claims, in each state the host sends', () => {
    const claimed = webPlugin.toolRenderers?.flatMap(({ tools, message }) =>
      tools.map((tool) => [tool, message] as const),
    );
    expect(claimed?.length).toBeGreaterThan(0);

    for (const [toolName, message] of claimed ?? []) {
      // result is null until the tool produces output, partial while it runs,
      // and final afterwards; a renderer has to survive all three.
      const pending = toolMessagePropsFixture({ toolName, running: true });
      const failed = toolMessagePropsFixture({
        toolName,
        isError: true,
        output: 'the launcher is unavailable',
        result: { content: [{ type: 'text', text: 'the launcher is unavailable' }], details: undefined },
      });
      expect(renderPlugin(message, pending.props).error, `${toolName} pending`).toBeUndefined();
      expect(renderPlugin(message, failed.props).error, `${toolName} failed`).toBeUndefined();
    }
  });

  it('rejects a malformed channel payload at the parse gate', () => {
    for (const channel of webPlugin.channels ?? []) {
      expect(driveChannel(channel, 's1', 'junk').accepted, channel.channel).toBe(false);
    }
  });

  it('runs each leader binding that acts on the client', () => {
    const fixture = slotPropsFixture({ sessionId: 's1' });
    const context = {
      sessionId: 's1',
      openTab: fixture.props.openTab,
      sendSessionFrame: fixture.props.sendSessionFrame,
    };
    const runnable = webPlugin.leaderBindings?.filter((binding) => 'run' in binding) ?? [];

    for (const binding of runnable) {
      if ('run' in binding) binding.run(context);
    }

    expect(runnable.length).toBeGreaterThan(0);
    expect(fixture.actions.map(({ action, target }) => `${action}:${String(target)}`)).toEqual(
      runnable.map(() => 'openTab:workflows'),
    );
  });
});
