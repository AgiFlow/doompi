import { describe, expect, it } from 'vitest';
import { sha256Base64Url } from '../../../src/adapters/node/digest.ts';
import {
  createChildPromptCacheProjection,
  createParentPromptCacheNamespace,
  createPromptCacheKey,
  createPromptCacheModelFingerprint,
} from '../../../src/services/namespace.ts';
import type { PromptCacheParentState } from '../../../src/types/cache.ts';

function parentState(overrides: Partial<PromptCacheParentState> = {}): PromptCacheParentState {
  return {
    rootSessionId: 'session-root',
    compositionFingerprint: 'composition-1',
    majorMode: 'developer',
    domains: ['typescript', 'testing'],
    profile: 'work',
    persona: '/repo/personas/reviewer.md',
    minorModes: [
      { source: '@agimon-ai/doompi-plan', id: 'plan', activation: 'active', modelContextVariant: 'normal' },
      { source: '@agimon-ai/doompi-goal', id: 'goal', activation: 'inactive', modelContextVariant: 'goal-1' },
    ],
    ...overrides,
  };
}

describe('prompt cache namespaces', () => {
  it('produces opaque provider keys below the OpenAI limit', () => {
    const namespace = createParentPromptCacheNamespace(parentState(), sha256Base64Url);
    const model = createPromptCacheModelFingerprint(
      { virtualProvider: 'openai', virtualModel: 'gpt-5', api: 'openai-responses', wireModel: 'gpt-5' },
      sha256Base64Url,
    );
    const key = createPromptCacheKey(namespace, 'parent', model, sha256Base64Url);

    expect(key).toMatch(/^dpc1_[A-Za-z0-9_-]{43}$/u);
    expect(Array.from(key)).toHaveLength(48);
    expect(key).not.toContain('session-root');
    expect(key).not.toContain('work');
  });

  it('preserves domain order and restores the same A to B to A namespace', () => {
    const stateA = parentState();
    const stateB = parentState({ domains: ['testing', 'typescript'] });
    const firstA = createParentPromptCacheNamespace(stateA, sha256Base64Url);
    const b = createParentPromptCacheNamespace(stateB, sha256Base64Url);
    const secondA = createParentPromptCacheNamespace(stateA, sha256Base64Url);

    expect(firstA).not.toBe(b);
    expect(secondA).toBe(firstA);
  });

  it('excludes transient revisions and UI state from canonical identity', () => {
    const baseline = parentState() as PromptCacheParentState & Record<string, unknown>;
    const transient = {
      ...parentState(),
      catalogRevision: 99,
      hostGeneration: 'host-2',
      detail: 'workflow progress 8 of 10',
      color: 'magenta',
      actions: [{ id: 'stop' }],
    } as PromptCacheParentState & Record<string, unknown>;

    expect(createParentPromptCacheNamespace(transient, sha256Base64Url)).toBe(
      createParentPromptCacheNamespace(baseline, sha256Base64Url),
    );
  });
  it('sorts active minor modes and excludes inactive modes', () => {
    const modes = [
      { source: 'z', id: 'two', activation: 'active' },
      { source: 'a', id: 'one', activation: 'activating', modelContextVariant: 'debug' },
      { source: 'ignored', id: 'inactive', activation: 'inactive', modelContextVariant: 'transient' },
    ];
    const reversed = [...modes].reverse();
    const first = createParentPromptCacheNamespace(parentState({ minorModes: modes }), sha256Base64Url);
    const second = createParentPromptCacheNamespace(parentState({ minorModes: reversed }), sha256Base64Url);
    const changedVariant = createParentPromptCacheNamespace(
      parentState({ minorModes: [{ source: 'a', id: 'one', activation: 'active', modelContextVariant: 'fable' }] }),
      sha256Base64Url,
    );

    expect(first).toBe(second);
    expect(changedVariant).not.toBe(first);
  });

  it('keeps equivalent child projections stable and preserves ordered model-visible inputs', () => {
    const projection = {
      systemPrompt: 'child prompt',
      tools: ['read', 'bash'],
      excludedTools: ['write', 'edit'],
      extensions: ['/runtime.mjs', '/agent.mjs'],
      inheritProjectContext: false,
      inheritSkills: true,
      fanout: false,
      structuredOutputSchema: { required: ['answer'], properties: { answer: { type: 'string' } }, type: 'object' },
    } as const;
    const first = createChildPromptCacheProjection(projection, sha256Base64Url);
    const equivalent = createChildPromptCacheProjection(
      {
        ...projection,
        excludedTools: ['edit', 'write'],
        structuredOutputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      },
      sha256Base64Url,
    );
    const reorderedTools = createChildPromptCacheProjection(
      { ...projection, tools: ['bash', 'read'] },
      sha256Base64Url,
    );

    expect(equivalent).toBe(first);
    expect(reorderedTools).not.toBe(first);
  });

  it('restores the same model fingerprint after a model switch', () => {
    const modelA = { virtualProvider: 'openai', virtualModel: 'gpt-5', api: 'openai-responses' };
    const modelB = { virtualProvider: 'anthropic', virtualModel: 'claude', api: 'anthropic-messages' };
    const firstA = createPromptCacheModelFingerprint(modelA, sha256Base64Url);
    expect(createPromptCacheModelFingerprint(modelB, sha256Base64Url)).not.toBe(firstA);
    expect(createPromptCacheModelFingerprint(modelA, sha256Base64Url)).toBe(firstA);
  });
});
