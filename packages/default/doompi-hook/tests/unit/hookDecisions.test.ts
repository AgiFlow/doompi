import { describe, expect, it } from 'vitest';
import {
  additionalContextsFrom,
  decisionReason,
  decisionsFrom,
  failuresFrom,
  hookFailureMessage,
  isDenied,
  toolResultMessages,
} from '../../src/services/hookDecisions.ts';
import type { HookOutcome } from '../../src/types/hooks.ts';

const outcomes: HookOutcome[] = [
  { decision: { decision: 'block', reason: 'approval required' } },
  {},
  { failure: { command: 'guard', message: 'exited with code 2', reason: 'non_zero_exit' } },
  { decision: { hookSpecificOutput: { additionalContext: 'Use the safe path.' } } },
];

describe('hook outcome interpretation', () => {
  it('separates decisions from failures and ignores the outcomes with neither', () => {
    expect(decisionsFrom(outcomes)).toHaveLength(2);
    expect(failuresFrom(outcomes).map((failure) => failure.reason)).toEqual(['non_zero_exit']);
  });

  it('recognises both spellings a hook can refuse with', () => {
    expect(isDenied({ decision: 'block' })).toBe(true);
    expect(isDenied({ hookSpecificOutput: { permissionDecision: 'deny' } })).toBe(true);
    expect(isDenied({ hookSpecificOutput: { permissionDecision: 'allow' } })).toBe(false);
    expect(isDenied({ decision: 'approve' })).toBe(false);
    expect(isDenied(undefined)).toBe(false);
  });

  it('prefers the top-level reason and falls back to the hook-specific one', () => {
    expect(decisionReason({ reason: 'top', hookSpecificOutput: { reason: 'nested' } })).toBe('top');
    expect(decisionReason({ hookSpecificOutput: { reason: 'nested' } })).toBe('nested');
    expect(decisionReason({})).toBeUndefined();
    expect(decisionReason(undefined)).toBeUndefined();
  });

  it('collects only the decisions that carry additional context', () => {
    expect(additionalContextsFrom(decisionsFrom(outcomes))).toEqual(['Use the safe path.']);
  });

  it('falls back to the reason when a post-tool hook set no additional context', () => {
    expect(toolResultMessages(decisionsFrom(outcomes))).toEqual(['approval required', 'Use the safe path.']);
    expect(toolResultMessages([{ decision: 'block' }])).toEqual([]);
  });

  it('names every missed check and what the agent may do about it', () => {
    const message = hookFailureMessage(failuresFrom(outcomes));

    expect(message).toContain('- guard: exited with code 2');
    expect(message).toContain('Ask the user before bypassing a hook that may enforce a guardrail.');
  });
});
