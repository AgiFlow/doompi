import { describe, expect, it } from 'vitest';
import { brokeredProviderOverrides } from '../../../src/services/brokerProviders.ts';
import { BROKER_PROVIDERS_ENV } from '../../../src/services/sandboxBridge.ts';

describe('brokeredProviderOverrides', () => {
  it('points each brokered provider at its bridge path', () => {
    expect(brokeredProviderOverrides({ [BROKER_PROVIDERS_ENV]: 'anthropic,openai' })).toEqual([
      { provider: 'anthropic', baseUrl: 'http://127.0.0.1:8317/anthropic' },
      { provider: 'openai', baseUrl: 'http://127.0.0.1:8317/openai' },
    ]);
  });

  it('overrides nothing outside a brokered sandbox', () => {
    expect(brokeredProviderOverrides({})).toEqual([]);
    expect(brokeredProviderOverrides({ [BROKER_PROVIDERS_ENV]: '  ' })).toEqual([]);
  });

  it('tolerates padded and empty entries in the launch variable', () => {
    expect(brokeredProviderOverrides({ [BROKER_PROVIDERS_ENV]: ' anthropic , ,groq ' })).toEqual([
      { provider: 'anthropic', baseUrl: 'http://127.0.0.1:8317/anthropic' },
      { provider: 'groq', baseUrl: 'http://127.0.0.1:8317/groq' },
    ]);
  });
});
