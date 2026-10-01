import {
  driveChannel,
  renderPlugin,
  slotPropsFixture,
  toolMessagePropsFixture,
} from '@agimon-ai/doompi-core/webTesting';
import { afterEach, describe, expect, it } from 'vitest';

import { webPlugin as scopedWebPlugin } from '../../generated/web';
import { catalog } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/catalogStore';
import { workflows } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/workflowsStore';
const webPlugin = {
  id: scopedWebPlugin.id,
  ...scopedWebPlugin.global,
  ...scopedWebPlugin.workspace,
  ...scopedWebPlugin.session,
};

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
  ownerSessionId: 's1',
  jobs: [
    {
      name: 'draft',
      phase: 'job',
      status: 'running',
      steps: [{ name: 'outline', status: 'running', ref: { kind: 'session', id: 'step-1' } }],
    },
  ],
};

const dockFace = () => webPlugin.dockFaces?.find((face) => face.id === 'workflow');
const activitySection = () => webPlugin.fills?.find((fill) => fill.slot === 'activity.workflows');
const overlay = () => webPlugin.fills?.find((fill) => fill.slot === 'overlay');

afterEach(() => {
  workflows.reset();
  catalog.reset();
});

describe('the workflows plugin surfaces', () => {
  it('declares no tab: the runs live in their workflow sessions and the dock', () => {
    expect(webPlugin.tabs ?? []).toEqual([]);
    expect(webPlugin.activityGroups?.[0]?.transientTab).toBeUndefined();
  });

  it('shows the workflow dock face only in a session that owns a run', () => {
    const face = dockFace();
    const channel = webPlugin.channels?.find((candidate) => candidate.channel === 'workflow_runs');
    expect(face?.autoSelect).toBe(true);
    expect(face?.visibility?.isVisible('s1')).toBe(false);

    driveChannel(channel!, 's1', { runs: [run, { ...run, runKey: 'handed-1', ownerSessionId: 's9' }] });
    expect(face?.visibility?.isVisible('s1')).toBe(true);
    // A run handed to another session's workflow session does not make the face appear here.
    driveChannel(channel!, 's2', { runs: [{ ...run, ownerSessionId: 's9', launcherSessionId: 's2' }] });
    expect(face?.visibility?.isVisible('s2')).toBe(false);
  });

  it('renders the dock face with the run, its active step and its jobs', () => {
    const channel = webPlugin.channels?.find((candidate) => candidate.channel === 'workflow_runs');
    driveChannel(channel!, 's1', { runs: [run] });
    const rendered = renderPlugin(dockFace()!.panel, slotPropsFixture({ sessionId: 's1' }).props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('blog-writing')).toBe(true);
    expect(rendered.includes('ACTIVE NOW')).toBe(true);
    expect(rendered.includes('outline')).toBe(true);
  });

  it('keeps the idle activity section available as a workflow launcher', () => {
    const group = webPlugin.activityGroups?.[0];
    const section = activitySection();
    const rendered = renderPlugin(section!.component!, slotPropsFixture({ sessionId: 's1' }).props);

    expect(group?.activeSource?.isActive('s1')).toBe(false);
    expect(section?.id).toBe('workflows');
    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('idle')).toBe(true);
    expect(rendered.includes('launch a workflow')).toBe(true);
  });

  it('renders the activity section with a run reported by the hub', () => {
    const channel = webPlugin.channels?.find((candidate) => candidate.channel === 'workflow_runs');
    driveChannel(channel!, 's1', { runs: [{ ...run, ownerSessionId: 'wf-1', launcherSessionId: 's1' }] });

    const rendered = renderPlugin(activitySection()!.component!, slotPropsFixture({ sessionId: 's1' }).props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('blog-writing')).toBe(true);
    expect(rendered.html).toContain('data-delegated="true"');
    expect(webPlugin.activityGroups?.[0]?.activeSource?.isActive('s1')).toBe(true);
  });

  it('mounts the launcher overlay closed', () => {
    const rendered = renderPlugin(overlay()!.component!, slotPropsFixture({ sessionId: 's1' }).props);
    expect(rendered.error).toBeUndefined();
  });

  it('renders every surface with nothing focused', () => {
    // The host holds sessionId null before anything is focused and after the
    // last session closes, and every component is mounted in both states.
    const { props } = slotPropsFixture({ sessionId: null });

    const faces = webPlugin.dockFaces ?? [];
    for (const surface of [...(webPlugin.tabs ?? []), ...faces, ...(webPlugin.fills ?? [])]) {
      const component = 'panel' in surface ? surface.panel : surface.component;
      const id = 'id' in surface ? surface.id : 'unknown';
      expect(renderPlugin(component!, props).error, id).toBeUndefined();
    }
  });

  it('renders every tool it claims, in each state the host sends', () => {
    const claimed = webPlugin.toolRenderers?.flatMap(({ tools, message }) =>
      tools.map((tool) => [tool, message] as const),
    );
    expect(claimed?.length).toBeGreaterThan(0);
    expect(claimed?.map(([tool]) => tool)).toContain('workflow_tools');

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
      openTransientTab: fixture.props.openTransientTab,
      sendSessionFrame: fixture.props.sendSessionFrame,
    };
    const runnable = webPlugin.leaderBindings?.filter((binding) => 'run' in binding) ?? [];

    for (const binding of runnable) {
      if ('run' in binding) binding.run(context);
    }

    expect(runnable.map((binding) => binding.id)).toEqual(['doom-workflow.catalog']);
    // SPC w l opens the catalog over the session; no binding opens a tab.
    expect(fixture.actions).toEqual([]);
    expect(catalog.select(catalog.store.state, 's1').open).toBe(true);
    expect(webPlugin.leaderBindings?.map((binding) => binding.path.at(-1)?.key)).toEqual(['l', 'e']);
  });
});
