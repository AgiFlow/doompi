import { describe, expect, it } from 'vitest';
import { createRecentPrompts, RECENT_PROMPT_LIMIT } from '../../../src/services/recentPrompts.ts';

describe('the staged prompt ring', () => {
  it('lists the newest prompt first', () => {
    const recent = createRecentPrompts();

    recent.push('first');
    recent.push('second');

    expect(recent.list()).toEqual(['second', 'first']);
  });

  it('keeps only the last three prompts', () => {
    const recent = createRecentPrompts();

    for (const text of ['one', 'two', 'three', 'four']) recent.push(text);

    expect(RECENT_PROMPT_LIMIT).toBe(3);
    expect(recent.list()).toEqual(['four', 'three', 'two']);
  });

  it('trims entries and ignores blank submissions', () => {
    const recent = createRecentPrompts();

    recent.push('  padded  ');
    recent.push('   ');
    recent.push('\n');

    expect(recent.list()).toEqual(['padded']);
  });

  it('skips a consecutive duplicate but keeps an earlier repeat', () => {
    const recent = createRecentPrompts();

    recent.push('same');
    recent.push('same');
    recent.push('other');
    recent.push('same');

    expect(recent.list()).toEqual(['same', 'other', 'same']);
  });

  it('honours a smaller limit for callers that want one', () => {
    const recent = createRecentPrompts(1);

    recent.push('older');
    recent.push('newer');

    expect(recent.list()).toEqual(['newer']);
  });
});
