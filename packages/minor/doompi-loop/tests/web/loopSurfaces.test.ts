import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { webPlugin as scopedWebPlugin } from '../../generated/web';
import { LoopActivityItems } from '../../src/extensions/workspaces/sessions/(frontend)/fill/_components/LoopsActivitySection';
import { LOOP_VIEW_STATUS_KEY } from '../../src/types/loopView';
const webPlugin = {
  id: scopedWebPlugin.id,
  ...scopedWebPlugin.global,
  ...scopedWebPlugin.workspace,
  ...scopedWebPlugin.session,
};

const payload = JSON.stringify([
  { instanceId: 'starting-loop', label: 'Starting loop', detail: 'every 30s', state: 'starting' },
  { instanceId: 'running-loop', label: 'Running loop', detail: 'every 60s', state: 'running' },
  { instanceId: 'stopping-loop', label: 'Stopping loop', detail: 'every 90s', state: 'stopping' },
]);

const loopsActivityFill = webPlugin.fills?.find(({ slot }) => slot === 'activity.loops')?.component;
if (!loopsActivityFill) throw new Error('Expected the Loop activity fill.');

describe('Loop web surfaces', () => {
  it('declares the Loop mode, idle activity group, slots, and command bindings', () => {
    expect(webPlugin.minorModes).toEqual([{ name: 'loop', keys: 'l l', statusKey: 'doom-loop', order: 30 }]);
    expect(webPlugin.activityGroups).toEqual([
      expect.objectContaining({ name: 'loops', keys: 'l l', statusKey: LOOP_VIEW_STATUS_KEY, order: 40 }),
    ]);
    // No activeSource: the group's visibility is the status the server facet
    // publishes, so a running loop marks background work instead of a
    // placeholder source hard-wiring it to false.
    expect(webPlugin.activityGroups?.[0]?.activeSource).toBeUndefined();
    expect(webPlugin.slots?.map(({ slot }) => slot)).toEqual(['loop.items', 'loop.registration']);
    expect(webPlugin.fills?.map(({ slot, id }) => ({ slot, id }))).toEqual([
      { slot: 'loop.items', id: 'instances' },
      { slot: 'activity.loops', id: 'loops' },
    ]);
    expect(webPlugin.leaderBindings?.map(({ id }) => id)).toEqual(['loop.list']);
  });

  it('renders semantic rows, lifecycle labels, and full detail text', () => {
    const rendered = renderPlugin(
      LoopActivityItems,
      slotPropsFixture({ statuses: { [LOOP_VIEW_STATUS_KEY]: payload } }).props,
    );
    const { html } = rendered;
    expect(rendered.error).toBeUndefined();

    expect(html).toContain('aria-label="active loops"');
    expect(html).toContain('Starting loop');
    expect(html).toContain('Running loop');
    expect(html).toContain('Stopping loop');
    expect(html).toContain('every 30s');
    expect(html).toContain('data-loop-state="starting"');
    expect(html).toContain('data-loop-state="running"');
    expect(html).toContain('data-loop-state="stopping"');
  });

  it('renders nothing for absent status and a defensive fallback for malformed data', () => {
    expect(renderPlugin(LoopActivityItems, slotPropsFixture().props).html).toBe('');

    const rendered = renderPlugin(
      LoopActivityItems,
      slotPropsFixture({ statuses: { [LOOP_VIEW_STATUS_KEY]: 'not json' } }).props,
    );
    const { html } = rendered;
    expect(rendered.error).toBeUndefined();
    expect(html).toContain('loop status unavailable');
  });

  it('lists loops whatever the mode and tells the user how to set one', () => {
    const render = (activeMinorModes: string[], raw?: string) =>
      renderPlugin(loopsActivityFill, {
        ...slotPropsFixture({
          ...(raw === undefined ? {} : { statuses: { [LOOP_VIEW_STATUS_KEY]: raw } }),
          slotContent: { 'loop.items': createElement('span', { 'data-testid': 'loop-items-slot' }) },
        }).props,
        activeMinorModes,
      });

    const inactive = render([], payload);
    expect(inactive.error).toBeUndefined();
    expect(inactive.html).toContain('data-testid="loop-items-slot"');
    expect(inactive.html).toContain('Activate loop minor mode to set loop or cron job.');
    expect(inactive.html).not.toContain('default loop');

    expect(render(['loop']).html).toContain('Ask the agent to set a loop or cron job.');
    expect(render(['loop'], payload).html).not.toContain('activity-loops-hint');
  });
});
