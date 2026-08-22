import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDomainSwitchHandoffStore,
  DOMAIN_SWITCH_HANDOFF_MAX_DOMAINS,
  DOMAIN_SWITCH_HANDOFF_TTL_MS,
} from '../../src/adapters/domainSwitchHandoff.ts';

const identity = { sessionId: 'voice-session', hostGeneration: 'host-generation' };
const request = {
  ...identity,
  operationId: 'voice-operation',
  domains: ['development', 'development', 'qa'],
  reloadHandoffToken: 'voice-reload-token',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('domain switch handoff store', () => {
  it('normalizes domains, enforces session identity, and consumes once', () => {
    const store = createDomainSwitchHandoffStore();
    const handoff = store.issue(request);

    expect(handoff.domains).toEqual(['development', 'qa']);
    expect(store.consume(handoff.token, { ...identity, sessionId: 'other-session' })).toBeUndefined();
    expect(store.consume(handoff.token, identity)).toMatchObject({
      sessionId: identity.sessionId,
      hostGeneration: identity.hostGeneration,
      reloadHandoffToken: request.reloadHandoffToken,
    });
    expect(store.consume(handoff.token, identity)).toBeUndefined();
    store.dispose();
  });

  it('requires the exact host generation even from untyped callers', () => {
    const store = createDomainSwitchHandoffStore();
    const handoff = store.issue(request);

    expect(() => store.consume(handoff.token, { sessionId: identity.sessionId } as typeof identity)).toThrow(
      'Invalid domain switch handoff host generation.',
    );
    store.dispose();
  });

  it('rejects a handoff minted by another host generation', () => {
    const store = createDomainSwitchHandoffStore();
    const handoff = store.issue(request);

    expect(store.consume(handoff.token, { ...identity, hostGeneration: 'other-host' })).toBeUndefined();
    expect(store.discard(handoff.token, { ...identity, hostGeneration: 'other-host' })).toBe(false);
    store.dispose();
  });

  it('allows an explicit empty selection and isolates duplicate store owners', () => {
    const first = createDomainSwitchHandoffStore();
    const second = createDomainSwitchHandoffStore();
    const handoff = first.issue({ ...request, domains: [] });

    expect(handoff.domains).toEqual([]);
    expect(first.dispose()).toBe(1);
    expect(second.consume(handoff.token, identity)).toBeUndefined();

    const secondHandoff = second.issue({ ...request, domains: ['quality'] });
    expect(first.dispose()).toBe(0);
    expect(second.discard(secondHandoff.token, identity)).toBe(true);
    expect(second.dispose()).toBe(0);
  });

  it('clears only the owning session and expires records', () => {
    vi.useFakeTimers();
    const store = createDomainSwitchHandoffStore();
    const first = store.issue(request);
    const second = store.issue({ ...request, sessionId: 'other-session', operationId: 'other-operation' });

    expect(store.clearSession(identity.sessionId)).toBe(1);
    expect(store.consume(first.token, identity)).toBeUndefined();
    expect(
      store.consume(second.token, { sessionId: 'other-session', hostGeneration: identity.hostGeneration }),
    ).toBeDefined();

    const expired = store.issue(request);
    vi.advanceTimersByTime(DOMAIN_SWITCH_HANDOFF_TTL_MS + 1);
    expect(store.consume(expired.token, identity)).toBeUndefined();
    store.dispose();
  });

  it('rejects selections beyond the bounded domain count', () => {
    const store = createDomainSwitchHandoffStore();
    expect(() =>
      store.issue({
        ...request,
        domains: Array.from({ length: DOMAIN_SWITCH_HANDOFF_MAX_DOMAINS + 1 }, (_, index) => `domain-${index}`),
      }),
    ).toThrow(/maximum/u);
    store.dispose();
  });

  it('names the field behind every rejected identifier', () => {
    const store = createDomainSwitchHandoffStore();

    expect(() => store.issue({ ...request, sessionId: '  ' })).toThrow('Invalid domain switch handoff session id.');
    expect(() => store.issue({ ...request, hostGeneration: '' })).toThrow(
      'Invalid domain switch handoff host generation.',
    );
    expect(() => store.issue({ ...request, operationId: 'has space' })).toThrow(
      'Invalid domain switch handoff operation id.',
    );
    expect(() => store.issue({ ...request, reloadHandoffToken: 'line\nbreak' })).toThrow(
      'Invalid domain switch handoff reload handoff token.',
    );
    expect(() => store.issue({ ...request, domains: ['../escape'] })).toThrow(
      'Invalid domain switch handoff domain name.',
    );
    expect(() => store.consume('bad token', identity)).toThrow('Invalid domain switch handoff token.');
    store.dispose();
  });

  it('turns inert once disposed rather than resurrecting a stale generation', () => {
    const store = createDomainSwitchHandoffStore();
    const handoff = store.issue(request);
    store.dispose();

    expect(() => store.issue(request)).toThrow('disposed');
    expect(store.consume(handoff.token, identity)).toBeUndefined();
    expect(store.discard(handoff.token, identity)).toBe(false);
    expect(store.clearSession(identity.sessionId)).toBe(0);
    expect(store.dispose()).toBe(0);
  });

  it('reports no match for a token that was never issued', () => {
    const store = createDomainSwitchHandoffStore();

    expect(store.consume('doom-domain-switch:missing', identity)).toBeUndefined();
    expect(store.discard('doom-domain-switch:missing', identity)).toBe(false);
    store.dispose();
  });
});
