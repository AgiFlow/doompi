import { describe, expect, it } from 'vitest';
import { formatGoalStatusView, parseGoalStatusView } from '../../src/types/goalView.ts';

/**
 * The wire format between the session and the activity dock.
 *
 * It travels on a status line, which is a plain string the host relays raw, so
 * everything the dock knows about the goal survives or dies here.
 */
describe('the goal status line', () => {
  it('round-trips the state and the objective', () => {
    const line = formatGoalStatusView('ship the release-group fix', 'active 12.4k/100k');

    expect(parseGoalStatusView(line)).toEqual({ state: 'active 12.4k/100k', objective: 'ship the release-group fix' });
  });

  it('keeps an objective that contains the separator whole', () => {
    // The split is on the first separator, not the last, so a goal worded with
    // one does not lose everything before its last occurrence.
    const objective = 'read a · then b · then c';

    expect(parseGoalStatusView(formatGoalStatusView(objective, 'paused'))).toEqual({ state: 'paused', objective });
  });

  it('reads a status the session themed, because the dock hands them over raw', () => {
    const line = `[33m${formatGoalStatusView('themed', 'active 4m')}[0m`;

    expect(parseGoalStatusView(line)).toEqual({ state: 'active 4m', objective: 'themed' });
  });

  it('reports no goal for an absent, empty, or objective-less line', () => {
    expect(parseGoalStatusView(undefined)).toBeUndefined();
    expect(parseGoalStatusView('')).toBeUndefined();
    // A state on its own is what the footer's own key already carries; without
    // an objective there is no row to draw.
    expect(parseGoalStatusView('active 4m')).toBeUndefined();
    expect(parseGoalStatusView('active 4m ·   ')).toBeUndefined();
  });
});
