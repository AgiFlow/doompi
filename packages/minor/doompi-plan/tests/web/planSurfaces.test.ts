import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { describe, expect, it } from 'vitest';
import { formatPlanStatus, PLAN_STATUS_KEY } from '../../src/types/planApi.ts';
import { webPlugin } from '../../web/index.ts';
import { PlanActivitySection } from '../../web/PlanActivitySection.tsx';
import { PLAN_TAB_ID, PlanPanel, planTab } from '../../web/PlanPanel.tsx';

/**
 * The two surfaces this package adds to the cockpit, mounted.
 *
 * Both are reached the same way in a browser and never in a unit test, so the
 * ordinary failures, a prop read off a session the host says is null or a
 * status the session has not published, would first appear as a swallowed
 * fallback on a page nobody is watching.
 */

const STATUS = formatPlanStatus('cockpit-plan-surface', '10:04:50');

describe('the plan group in the activity dock', () => {
  it('names the plan the session wrote and when it last wrote it', () => {
    const fixture = slotPropsFixture({ statuses: { [PLAN_STATUS_KEY]: STATUS } });

    const rendered = renderPlugin(PlanActivitySection, fixture.props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('cockpit-plan-surface')).toBe(true);
    expect(rendered.includes('10:04:50')).toBe(true);
    expect(rendered.html).toContain('data-testid="activity-plan-open"');
  });

  it('says so when the session has written no plan', () => {
    const rendered = renderPlugin(PlanActivitySection, slotPropsFixture().props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('no plan written yet')).toBe(true);
  });

  it('reads a status the session themed, because the dock hands them over raw', () => {
    const fixture = slotPropsFixture({ statuses: { [PLAN_STATUS_KEY]: `[33m${STATUS}[0m` } });

    expect(renderPlugin(PlanActivitySection, fixture.props).includes('cockpit-plan-surface')).toBe(true);
  });

  it('mounts with no focused session, which is how the host renders the dock between sessions', () => {
    const fixture = slotPropsFixture({ sessionId: null, statuses: { [PLAN_STATUS_KEY]: STATUS } });

    const rendered = renderPlugin(PlanActivitySection, fixture.props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('disabled');
  });
});

describe('the plan tab', () => {
  it('opens on the id the panel closes itself by', () => {
    // The panel closes by a literal id and the section opens by the factory's;
    // a disagreement leaves a tab that cannot be closed from inside it.
    expect(planTab().id).toBe(PLAN_TAB_ID);
    expect(planTab().label).toBe('plan');
  });

  it('mounts before the session has answered, which is every first paint', () => {
    const fixture = slotPropsFixture({ statuses: { [PLAN_STATUS_KEY]: STATUS } });

    const rendered = renderPlugin(PlanPanel, fixture.props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('data-testid="plan-panel"');
  });

  it('mounts with no focused session, which fetches nothing', () => {
    const rendered = renderPlugin(PlanPanel, slotPropsFixture({ sessionId: null }).props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('data-testid="plan-panel"');
  });
});

describe('the plan plugin declaration', () => {
  it('fills the group it declares, so the dock draws the row and not the raw status', () => {
    // The host resolves the two by name: a section whose id names no group
    // renders after the dock instead of inside it, which is silent.
    const group = webPlugin.activityGroups?.find((entry) => entry.name === 'plan');

    expect(group).toMatchObject({ statusKey: PLAN_STATUS_KEY });
    expect(webPlugin.activitySections?.map((section) => section.id)).toContain(group?.name);
  });

  it('keys the group off the plan rather than the mode, so it outlives plan mode', () => {
    const group = webPlugin.activityGroups?.find((entry) => entry.name === 'plan');

    expect(group?.statusKey).not.toBe('plan-mode');
  });

  it('does not count a saved plan as background work, so the dock badge stays honest', () => {
    // Only agents, workflows and runners actually run; a plan is a document.
    const group = webPlugin.activityGroups?.find((entry) => entry.name === 'plan');

    expect(group?.marksBackgroundWork).toBe(false);
  });
});
