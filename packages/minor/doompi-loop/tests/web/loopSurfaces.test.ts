import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { describe, expect, it } from 'vitest';
import { LOOP_VIEW_STATUS_KEY } from '../../src/types/loopView.ts';
import { webPlugin } from '../../web/index.ts';

const payload = JSON.stringify([
  { instanceId: 'starting-loop', label: 'Starting loop', detail: 'every 30s', state: 'starting' },
  { instanceId: 'running-loop', label: 'Running loop', detail: 'every 60s', state: 'running' },
  { instanceId: 'stopping-loop', label: 'Stopping loop', detail: 'every 90s', state: 'stopping' },
]);

const LoopsActivitySection = webPlugin.activitySections?.[0]?.component;
if (!LoopsActivitySection) throw new Error('Expected the Loop activity section.');

describe('Loop web surfaces', () => {
  it('declares the Loop mode, activity group, section, and command bindings', () => {
    expect(webPlugin.minorModes).toEqual([{ name: 'loop', keys: 'l l', statusKey: 'doom-loop', order: 30 }]);
    expect(webPlugin.activityGroups).toEqual([
      { name: 'loops', keys: 'l l', statusKey: LOOP_VIEW_STATUS_KEY, hideWhenEmpty: true, order: 40 },
    ]);
    expect(webPlugin.activitySections?.map(({ id }) => id)).toEqual(['loops']);
    expect(webPlugin.leaderBindings?.map(({ id }) => id)).toEqual(['loop.start', 'loop.list']);
  });

  it('renders semantic rows, lifecycle labels, full detail text, and one manage action', () => {
    const rendered = renderPlugin(
      LoopsActivitySection,
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
    expect(html.match(/activity-loops-manage/gu)).toHaveLength(1);
  });

  it('renders nothing for an absent status and a defensive fallback for malformed data', () => {
    expect(renderPlugin(LoopsActivitySection, slotPropsFixture().props).html).toBe('');

    const rendered = renderPlugin(
      LoopsActivitySection,
      slotPropsFixture({ statuses: { [LOOP_VIEW_STATUS_KEY]: 'not json' } }).props,
    );
    const { html } = rendered;
    expect(rendered.error).toBeUndefined();
    expect(html).toContain('loop status unavailable');
    expect(html).toContain('activity-loops-manage');
  });

  it('disables manage without an active session', () => {
    const rendered = renderPlugin(
      LoopsActivitySection,
      slotPropsFixture({ sessionId: null, statuses: { [LOOP_VIEW_STATUS_KEY]: payload } }).props,
    );
    const { html } = rendered;
    expect(rendered.error).toBeUndefined();

    expect(html).toContain('data-testid="activity-loops-manage"');
    expect(html).toContain('disabled=""');
  });
});
