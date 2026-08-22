import { describe, expect, it } from 'vitest';

import { preflightSubagentDepth, resolveCurrentSubagentDepth } from '../../src/adapters/runs/shared/depthGuard';
import { SUBAGENT_PARENT_DEPTH_ENV } from '../../src/exports/env';

describe('resolveCurrentSubagentDepth', () => {
  it('resolves to depth 0 when the env var is entirely absent (a root session)', () => {
    expect(resolveCurrentSubagentDepth({})).toBe(0);
  });

  it('resolves a present, valid non-negative integer', () => {
    expect(resolveCurrentSubagentDepth({ [SUBAGENT_PARENT_DEPTH_ENV]: '3' })).toBe(3);
  });

  it('resolves 0 when the value is explicitly "0"', () => {
    expect(resolveCurrentSubagentDepth({ [SUBAGENT_PARENT_DEPTH_ENV]: '0' })).toBe(0);
  });

  it('throws, not silently falls back to 0, when the value is present but not an integer', () => {
    expect(() => resolveCurrentSubagentDepth({ [SUBAGENT_PARENT_DEPTH_ENV]: 'not-a-number' })).toThrow(/invalid value/);
  });

  it('throws when the value is a negative integer', () => {
    expect(() => resolveCurrentSubagentDepth({ [SUBAGENT_PARENT_DEPTH_ENV]: '-1' })).toThrow(/invalid value/);
  });

  it('throws when the value is a non-integer number', () => {
    expect(() => resolveCurrentSubagentDepth({ [SUBAGENT_PARENT_DEPTH_ENV]: '1.5' })).toThrow(/invalid value/);
  });

  it('throws when the value is an empty string', () => {
    expect(() => resolveCurrentSubagentDepth({ [SUBAGENT_PARENT_DEPTH_ENV]: '' })).toThrow(/invalid value/);
  });
});

describe('preflightSubagentDepth', () => {
  it('allows a spawn with no configured limit', () => {
    const result = preflightSubagentDepth(5, {});
    expect(result.error).toBeUndefined();
    expect(result.limit).toBeUndefined();
  });

  it('treats a configured limit of 0 as unlimited, not as "no spawns"', () => {
    const result = preflightSubagentDepth(10, { maxSubagentDepth: 0 });
    expect(result.error).toBeUndefined();
  });

  it('allows a spawn strictly below the limit', () => {
    const result = preflightSubagentDepth(1, { maxSubagentDepth: 3 });
    expect(result.error).toBeUndefined();
  });

  it('allows a spawn exactly AT the limit - the boundary itself is not refused', () => {
    const result = preflightSubagentDepth(3, { maxSubagentDepth: 3 });
    expect(result.error).toBeUndefined();
  });

  it('refuses a spawn one past the limit', () => {
    const result = preflightSubagentDepth(4, { maxSubagentDepth: 3 });
    expect(result.error).toMatch(/depth 4/);
    expect(result.error).toMatch(/maxSubagentDepth of 3/);
  });

  it('refuses a spawn further past the limit, not just the boundary+1 case', () => {
    const result = preflightSubagentDepth(10, { maxSubagentDepth: 3 });
    expect(result.error).toBeDefined();
  });
});
