import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { LOOP_VIEW_STATUS_KEY } from '../../src/types/loopView.ts';
import { LoopActivityItems } from '../../src/web/components/LoopsActivitySection.tsx';
import { webPlugin as scopedWebPlugin } from '../../src/web/index.ts';
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

const loopsActivitySection = webPlugin.activitySections?.[0]?.component;
if (!loopsActivitySection) throw new Error('Expected the Loop activity section.');

describe('Loop web surfaces', () => {
  it('declares the Loop mode, idle activity group, slots, and command bindings', () => {
    expect(webPlugin.minorModes).toEqual([
      { name: 'loop', keys: 'l l', statusKey: 'doom-loop', activityGroup: 'loops', order: 30 },
    ]);
    expect(webPlugin.activityGroups).toEqual([
      expect.objectContaining({ name: 'loops', keys: 'l l', statusKey: LOOP_VIEW_STATUS_KEY, order: 40 }),
    ]);
    expect(webPlugin.activityGroups?.[0]?.activeSource?.isActive('s1')).toBe(false);
    expect(webPlugin.activityGroups?.[0]?.activeSource?.isActive(null)).toBe(false);
    expect(webPlugin.activitySections?.map(({ id }) => id)).toEqual(['loops']);
    expect(webPlugin.slots?.map(({ slot }) => slot)).toEqual(['loop.registration', 'loop.items']);
    expect(webPlugin.fills?.map(({ slot, id }) => ({ slot, id }))).toEqual([{ slot: 'loop.items', id: 'instances' }]);
    expect(webPlugin.leaderBindings?.map(({ id }) => id)).toEqual(['loop.start', 'loop.list']);
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

  it('keeps the idle activity section and both launcher surfaces available', () => {
    const rendered = renderPlugin(
      loopsActivitySection,
      slotPropsFixture({
        slotContent: {
          'loop.registration': createElement('span', { 'data-testid': 'loop-extension-slot' }, 'Agiflow loop'),
        },
      }).props,
    );
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('data-testid="activity-loops-manage"');
    expect(rendered.html).toContain('data-testid="activity-loop-default-launch"');
    expect(rendered.html).toContain('Agiflow loop');

    const withoutSession = renderPlugin(
      loopsActivitySection,
      slotPropsFixture({ sessionId: null, statuses: { [LOOP_VIEW_STATUS_KEY]: payload } }).props,
    );
    expect(withoutSession.error).toBeUndefined();
    expect(withoutSession.html).toContain('data-testid="activity-loops-manage"');
    expect(withoutSession.html).toContain('disabled=""');
  });
});
