// @scaffold-generated
import { describe, expect, it } from 'vitest';
import { hookDispatch } from '../../../src/services/hookDispatch';

describe('hookDispatch', () => {
  it('derives its result from its arguments alone', () => {
    expect(hookDispatch({ value: 'example' }, 1_000)).toEqual({ value: 'example', observedAt: 1_000 });
  });
});
