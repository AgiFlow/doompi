import { describe, expect, it } from 'vitest';
import { parseGoalCommand } from '../../src/services/parser.ts';
import { MAX_OBJECTIVE_LENGTH } from '../../src/types/goal.ts';
import { budgetHintOf, CLEAR_GOAL_COMMAND, editGoalCommand, normalizeObjective } from '../../web/goalCommands.ts';

/**
 * What the cockpit's edit form sends.
 *
 * The dialog previews the command it builds, so a command that does not parse
 * back to the edit the reader asked for is a lie told in the preview and caught
 * only on a live session. These assertions run the builder's output back
 * through the session's own parser to keep the two honest.
 */
describe('the goal edit command', () => {
  it('parses back to the edit the form describes', () => {
    const command = editGoalCommand('ship the release-group fix', '100k');

    expect(command).toBe('/goal edit --tokens 100k ship the release-group fix');
    expect(parseGoalCommand('edit --tokens 100k ship the release-group fix')).toEqual({
      kind: 'edit',
      objective: 'ship the release-group fix',
      tokenBudget: 100_000,
    });
  });

  it('collapses whitespace the way Pi would, so the preview matches the result', () => {
    expect(editGoalCommand('  ship   the\n  fix  ', '')).toBe('/goal edit ship the fix');
    expect(parseGoalCommand('edit ship the fix')).toMatchObject({ objective: 'ship the fix' });
  });

  it('omits --tokens for a blank budget, which is what keeps the current one', () => {
    expect(editGoalCommand('objective', '')).toBe('/goal edit objective');
    expect(editGoalCommand('objective', '   ')).toBe('/goal edit objective');
    expect(parseGoalCommand('edit objective')).toMatchObject({ tokenBudget: undefined });
  });

  it('accepts the budget wordings the session accepts', () => {
    expect(editGoalCommand('o', '1.5m')).toBe('/goal edit --tokens 1.5m o');
    expect(editGoalCommand('o', '500')).toBe('/goal edit --tokens 500 o');
    expect(editGoalCommand('o', '12.4k')).toBe('/goal edit --tokens 12.4k o');
  });

  it('refuses what the session would otherwise only reject after a round trip', () => {
    expect(editGoalCommand('', '')).toBeUndefined();
    expect(editGoalCommand('   \n ', '')).toBeUndefined();
    expect(editGoalCommand('objective', 'soon')).toBeUndefined();
    expect(editGoalCommand('objective', '9e3')).toBeUndefined();
    expect(editGoalCommand('x'.repeat(MAX_OBJECTIVE_LENGTH + 1), '')).toBeUndefined();
    expect(normalizeObjective('x'.repeat(MAX_OBJECTIVE_LENGTH))).toHaveLength(MAX_OBJECTIVE_LENGTH);
  });
});

describe('the budget hint', () => {
  it('takes the budget out of a state line as a value --tokens accepts', () => {
    expect(budgetHintOf('active 12.4k/100k')).toBe('100k');
    expect(budgetHintOf('budget 100k/100k')).toBe('100k');
    expect(editGoalCommand('o', budgetHintOf('active 12.4k/100k'))).toBe('/goal edit --tokens 100k o');
  });

  it('is empty for a goal with no budget, where the state carries elapsed time instead', () => {
    expect(budgetHintOf('active 4m')).toBe('');
    expect(budgetHintOf('paused')).toBe('');
  });
});

describe('the goal clear command', () => {
  it('is the verb the session already answers', () => {
    expect(CLEAR_GOAL_COMMAND).toBe('/goal clear');
    expect(parseGoalCommand('clear')).toEqual({ kind: 'clear' });
  });
});
