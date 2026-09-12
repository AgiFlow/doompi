import { describe, expect, it } from 'vitest';
import { resolveModelTokenOverrides } from '../src/services/modelOverrides';

const OPUS = { id: 'claude-opus-4-6', provider: 'anthropic' };

describe('autocompact model overrides', () => {
  it('matches a bare pattern against the model id, character classes included', () => {
    const overrides = [{ model: 'claude-opus-4-[6-9]', tokens: { pass1: 75_000 } }];
    expect(resolveModelTokenOverrides(OPUS, overrides)).toEqual({ 1: 75_000 });
    // 4-5 is a 200k window, deliberately outside the class.
    expect(resolveModelTokenOverrides({ id: 'claude-opus-4-5', provider: 'anthropic' }, overrides)).toEqual({});
  });

  it('matches a pattern naming a provider against provider and id together', () => {
    const overrides = [{ model: 'anthropic/claude-opus-4-6', tokens: { pass2: 150_000 } }];
    expect(resolveModelTokenOverrides(OPUS, overrides)).toEqual({ 2: 150_000 });
    // The same id reached through another provider is a different deployment.
    expect(resolveModelTokenOverrides({ id: 'claude-opus-4-6', provider: 'openrouter' }, overrides)).toEqual({});
  });

  it('does not let a bare pattern match a provider-qualified subject', () => {
    // The wildcard does not cross the separator, so a bare pattern only ever sees the id.
    expect(resolveModelTokenOverrides(OPUS, [{ model: 'anthropic/*', tokens: { pass1: 1 } }])).toEqual({ 1: 1 });
    expect(resolveModelTokenOverrides(OPUS, [{ model: '*', tokens: { pass1: 1 } }])).toEqual({ 1: 1 });
  });

  it('ignores case, so a pattern copied from a model list still matches', () => {
    expect(resolveModelTokenOverrides(OPUS, [{ model: 'Claude-Opus-4-6', tokens: { pass3: 200_000 } }])).toEqual({
      3: 200_000,
    });
  });

  it('takes the first matching entry rather than the most specific one', () => {
    const overrides = [
      { model: 'claude-opus-*', tokens: { pass1: 75_000 } },
      { model: 'claude-opus-4-6', tokens: { pass1: 10_000 } },
    ];
    expect(resolveModelTokenOverrides(OPUS, overrides)).toEqual({ 1: 75_000 });
  });

  it('returns nothing when no entry matches or the session has no model', () => {
    expect(
      resolveModelTokenOverrides({ id: 'gpt-5', provider: 'openai' }, [
        { model: 'claude-opus-4-[6-9]', tokens: { pass1: 75_000 } },
      ]),
    ).toEqual({});
    expect(resolveModelTokenOverrides(undefined, [{ model: '*', tokens: { pass1: 75_000 } }])).toEqual({});
    expect(resolveModelTokenOverrides(OPUS, [])).toEqual({});
  });

  it('carries only the passes the entry pins', () => {
    expect(resolveModelTokenOverrides(OPUS, [{ model: '*', tokens: { pass1: 75_000, pass3: 200_000 } }])).toEqual({
      1: 75_000,
      3: 200_000,
    });
  });
});
