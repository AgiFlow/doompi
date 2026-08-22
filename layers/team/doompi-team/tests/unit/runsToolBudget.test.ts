import { afterEach, describe, expect, it } from 'vitest';

import { TOOL_BUDGET_ENV } from '../../src/exports/env';
import {
  DEFAULT_TOOL_BUDGET_BLOCK,
  decodeToolBudgetEnv,
  encodeToolBudgetEnv,
  initialToolBudgetState,
  normalizeToolBudgetBlock,
  shouldBlockToolForBudget,
  toolBudgetBlockedMessage,
  toolBudgetSoftNudge,
  toolBudgetState,
  validateToolBudgetConfig,
  type ResolvedToolBudget,
} from '../../src/adapters/runs/shared/toolBudget';

const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

describe('tool budget validation', () => {
  it('returns nothing for an absent budget', () => {
    expect(validateToolBudgetConfig(undefined)).toEqual({});
  });

  it('settles the block list to the read-style default when unspecified', () => {
    expect(validateToolBudgetConfig({ hard: 5 }).budget).toEqual({
      hard: 5,
      block: [...DEFAULT_TOOL_BUDGET_BLOCK],
    });
  });

  it('rejects shapes that would leave the cap ambiguous', () => {
    expect(validateToolBudgetConfig(null).error).toBe(
      'toolBudget must be an object with hard and optional soft/block.',
    );
    expect(validateToolBudgetConfig([]).error).toContain('must be an object');
    expect(validateToolBudgetConfig({}).error).toBe('toolBudget.hard must be an integer >= 1.');
    expect(validateToolBudgetConfig({ hard: 0 }).error).toContain('hard must be an integer >= 1');
    expect(validateToolBudgetConfig({ hard: 1.5 }).error).toContain('hard must be an integer');
    expect(validateToolBudgetConfig({ hard: 5, soft: 0 }).error).toBe(
      'toolBudget.soft must be an integer >= 1 when provided.',
    );
    expect(validateToolBudgetConfig({ hard: 5, soft: 2.5 }).error).toContain('soft must be an integer');
    expect(validateToolBudgetConfig({ hard: 5, soft: 6 }).error).toBe('toolBudget.soft must be <= toolBudget.hard.');
    expect(validateToolBudgetConfig({ hard: 5, block: 'read' }).error).toBe(
      'toolBudget.block must be "*" or an array of tool names.',
    );
    expect(validateToolBudgetConfig({ hard: 5, block: [] }).error).toBe(
      'toolBudget.block must contain at least one tool name.',
    );
    expect(validateToolBudgetConfig({ hard: 5, block: ['  '] }).error).toBe(
      'toolBudget.block must contain non-empty tool names.',
    );
    expect(validateToolBudgetConfig({ hard: 5, block: [1] }).error).toContain('non-empty tool names');
  });

  it('allows hard 0 only on the explicitly zero-authorised path', () => {
    // Zero means "block from the first call", which a caller has to ask for; it
    // must not be reachable by accident from authored config.
    expect(validateToolBudgetConfig({ hard: 0 }, 'toolBudget', { minimumHard: 0 }).budget?.hard).toBe(0);
    expect(validateToolBudgetConfig({ hard: 0 }, 'toolBudget', { minimumHard: 1 }).error).toContain('>= 1');
  });

  it('normalizes an authored block list, keeping "*" as the block-all marker', () => {
    expect(normalizeToolBudgetBlock(undefined)).toEqual([...DEFAULT_TOOL_BUDGET_BLOCK]);
    expect(normalizeToolBudgetBlock('*')).toBe('*');
    expect(normalizeToolBudgetBlock([' read ', 'read', 'grep', ''])).toEqual(['read', 'grep']);
    expect(validateToolBudgetConfig({ hard: 5, soft: 2, block: ['read', 'read'] }).budget).toEqual({
      hard: 5,
      soft: 2,
      block: ['read'],
    });
    expect(validateToolBudgetConfig({ hard: 5, block: '*' }).budget?.block).toBe('*');
  });
});

describe('tool budget enforcement', () => {
  const budget: ResolvedToolBudget = { soft: 2, hard: 4, block: ['read', 'grep'] };

  it('starts within budget with no calls counted', () => {
    expect(initialToolBudgetState(budget)).toEqual({ ...budget, toolCount: 0, outcome: 'within-budget' });
  });

  it('nudges at the soft limit and only blocks past the hard one', () => {
    expect(toolBudgetState(budget, 1).outcome).toBe('within-budget');
    expect(toolBudgetState(budget, 2)).toEqual({ ...budget, toolCount: 2, outcome: 'soft-reached', softReachedAt: 2 });
    expect(toolBudgetState(budget, 4).outcome).toBe('soft-reached');
    expect(toolBudgetState(budget, 5, 'read')).toEqual({
      ...budget,
      toolCount: 5,
      outcome: 'hard-blocked',
      softReachedAt: 2,
      hardReachedAt: 4,
      blockedTool: 'read',
    });
  });

  it('never reports a soft nudge when no soft limit was configured', () => {
    const hardOnly: ResolvedToolBudget = { hard: 2, block: '*' };
    expect(toolBudgetState(hardOnly, 2).outcome).toBe('within-budget');
    expect(toolBudgetState(hardOnly, 3, 'read').outcome).toBe('hard-blocked');
  });

  it('lets the budgeted call through and refuses only the one after it', () => {
    // Blocking on the call that reaches the limit would silently deliver one
    // fewer tool call than the budget promised.
    expect(shouldBlockToolForBudget(budget, 'read', 4)).toBe(false);
    expect(shouldBlockToolForBudget(budget, 'read', 5)).toBe(true);
  });

  it('blocks only the listed tools so an over-budget child can still write', () => {
    expect(shouldBlockToolForBudget(budget, 'write', 5)).toBe(false);
    expect(shouldBlockToolForBudget(budget, 'edit', 5)).toBe(false);
    expect(shouldBlockToolForBudget({ hard: 4, block: '*' }, 'write', 5)).toBe(true);
  });

  it('names the limits in the messages the child actually reads', () => {
    expect(toolBudgetSoftNudge(budget, 1)).toContain('after 1 tool call (soft 2, hard 4)');
    expect(toolBudgetSoftNudge(budget, 2)).toContain('after 2 tool calls');
    expect(toolBudgetBlockedMessage(budget, 'read', 1)).toContain('after 1 tool call (hard 4)');
    expect(toolBudgetBlockedMessage(budget, 'read', 5)).toContain("The 'read' tool is blocked");
  });
});

describe('tool budget process handoff', () => {
  const budget: ResolvedToolBudget = { soft: 2, hard: 4, block: ['read'] };

  it('round-trips the budget through the environment value', () => {
    // Parent and child must never disagree about the cap, so the decoded value
    // has to equal the encoded one exactly.
    const encoded = encodeToolBudgetEnv(budget);
    expect(encoded).toBeDefined();
    expect(decodeToolBudgetEnv(encoded)).toEqual(budget);
    expect(decodeToolBudgetEnv(encodeToolBudgetEnv({ hard: 3, block: '*' }))).toEqual({ hard: 3, block: '*' });
  });

  it('encodes nothing when there is no budget', () => {
    expect(encodeToolBudgetEnv(undefined)).toBeUndefined();
  });

  it('decodes an absent or blank value as unbudgeted', () => {
    expect(decodeToolBudgetEnv(undefined)).toBeUndefined();
    expect(decodeToolBudgetEnv('   ')).toBeUndefined();
  });

  it('throws on an unreadable budget rather than running the child uncapped', () => {
    expect(() => decodeToolBudgetEnv('{')).toThrow();
    expect(() => decodeToolBudgetEnv('{"hard":0}')).toThrow(`${TOOL_BUDGET_ENV}.hard must be an integer >= 1.`);
  });

  it('accepts a zero hard limit when the caller opted into it', () => {
    expect(decodeToolBudgetEnv('{"hard":0}', { allowZero: true })).toEqual({
      hard: 0,
      block: [...DEFAULT_TOOL_BUDGET_BLOCK],
    });
  });
});
