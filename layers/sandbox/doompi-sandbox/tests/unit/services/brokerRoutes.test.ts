import { describe, expect, it } from 'vitest';
import { brokerRoutes, findBrokerRoute, resolveBrokeredCredentials } from '../../../src/services/brokerRoutes.ts';

describe('brokerRoutes', () => {
  it('routes anthropic and openai at the origins Pi ships', () => {
    expect(findBrokerRoute('anthropic')?.upstream).toBe('https://api.anthropic.com');
    expect(findBrokerRoute('openai')?.upstream).toBe('https://api.openai.com/v1');
  });

  it('has no duplicate providers and only https upstreams', () => {
    const providers = brokerRoutes().map((route) => route.provider);

    expect(new Set(providers).size).toBe(providers.length);
    expect(brokerRoutes().every((route) => route.upstream.startsWith('https://'))).toBe(true);
  });

  it('answers undefined for a provider it cannot terminate', () => {
    expect(findBrokerRoute('github-copilot')).toBeUndefined();
  });
});

describe('resolveBrokeredCredentials', () => {
  it('selects only providers whose key the host actually holds', () => {
    const resolved = resolveBrokeredCredentials({
      ANTHROPIC_API_KEY: 'anthropic-key',
      GROQ_API_KEY: 'groq-key',
      UNRELATED: 'value',
    });

    expect(resolved.map((credential) => credential.route.provider)).toEqual(['anthropic', 'groq']);
    expect(resolved.map((credential) => credential.envName)).toEqual(['ANTHROPIC_API_KEY', 'GROQ_API_KEY']);
    expect(resolved[0]?.value).toBe('anthropic-key');
  });

  it('ignores blank credentials so an empty variable does not claim a provider', () => {
    expect(resolveBrokeredCredentials({ ANTHROPIC_API_KEY: '   ' })).toEqual([]);
  });

  it('answers empty when the host holds nothing brokerable', () => {
    expect(resolveBrokeredCredentials({ PATH: '/usr/bin' })).toEqual([]);
  });
});
