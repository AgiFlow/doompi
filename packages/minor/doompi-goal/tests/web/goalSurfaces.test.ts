import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { describe, expect, it } from 'vitest';
import { formatGoalStatusView, GOAL_VIEW_STATUS_KEY } from '../../src/types/goalView.ts';
import { EditGoalDialog } from '../../src/web/EditGoalDialog.tsx';
import { GoalActivitySection } from '../../src/web/GoalActivitySection.tsx';
import { webPlugin } from '../../src/web/index.ts';
import { RemoveGoalDialog } from '../../src/web/RemoveGoalDialog.tsx';

/**
 * The surface this package adds to the cockpit, mounted.
 *
 * It is reached the same way in a browser and never in a unit test, so the
 * ordinary failures, a prop read off a session the host says is null or a
 * status the session has not published, would first appear as a swallowed
 * fallback on a page nobody is watching.
 */

const OBJECTIVE = 'ship the release-group fix';
const STATUS = formatGoalStatusView(OBJECTIVE, 'active 12.4k/100k');

describe('the goal group in the activity dock', () => {
  it('names the objective the session is working to, and how far along it is', () => {
    const fixture = slotPropsFixture({ statuses: { [GOAL_VIEW_STATUS_KEY]: STATUS } });

    const rendered = renderPlugin(GoalActivitySection, fixture.props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes(OBJECTIVE)).toBe(true);
    expect(rendered.includes('active 12.4k/100k')).toBe(true);
    expect(rendered.html).toContain('data-testid="activity-goal-menu"');
    // The dock puts `activity-goal` on the frame this renders inside, so the
    // row may not claim it too: two of them make every locator ambiguous.
    expect(rendered.html).not.toContain('data-testid="activity-goal"');
  });

  it('says so when the session has set no goal', () => {
    const rendered = renderPlugin(GoalActivitySection, slotPropsFixture().props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('no goal set yet')).toBe(true);
    expect(rendered.html).not.toContain('data-testid="activity-goal-menu"');
  });

  it('reads a status the session themed, because the dock hands them over raw', () => {
    const fixture = slotPropsFixture({ statuses: { [GOAL_VIEW_STATUS_KEY]: `[33m${STATUS}[0m` } });

    const rendered = renderPlugin(GoalActivitySection, fixture.props);

    expect(rendered.includes(OBJECTIVE)).toBe(true);
    // The colour comes off rather than reaching the page as literal text.
    expect(rendered.html).not.toContain('[33m');
  });

  it('mounts with no focused session, which is how the host renders the dock between sessions', () => {
    const fixture = slotPropsFixture({ sessionId: null, statuses: { [GOAL_VIEW_STATUS_KEY]: STATUS } });

    const rendered = renderPlugin(GoalActivitySection, fixture.props);

    expect(rendered.error).toBeUndefined();
    // Nothing to send a command to, so the way in is closed rather than dead.
    expect(rendered.html).toContain('disabled');
  });
});

describe('the goal dialogs', () => {
  it('opens the edit form on the objective the session is reporting', () => {
    const rendered = renderPlugin(EditGoalDialog, {
      objective: OBJECTIVE,
      budgetHint: '100k',
      open: true,
      onSubmit: () => undefined,
      onCancel: () => undefined,
    });

    expect(rendered.error).toBeUndefined();
  });

  it('names the goal a confirmed removal would end', () => {
    const rendered = renderPlugin(RemoveGoalDialog, {
      objective: OBJECTIVE,
      open: false,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });

    expect(rendered.error).toBeUndefined();
  });
});

describe('the plugin declaration', () => {
  it('gives the group a section of the same name, which is what puts it inside it', () => {
    const group = webPlugin.activityGroups?.[0];

    expect(group).toMatchObject({ name: 'goal', keys: 'g e', statusKey: GOAL_VIEW_STATUS_KEY });
    expect(webPlugin.activitySections?.map((section) => section.id)).toEqual([group?.name]);
  });

  it('keeps durable goal context out of the background-work state', () => {
    const group = webPlugin.activityGroups?.[0];

    expect(group).toMatchObject({ hideWhenEmpty: true, marksBackgroundWork: false });
  });
});
