import { describe, expect, it } from 'vitest';
import { brokeredProviderOverrides } from '../../../src/services/brokerProviders.ts';
import { BROKER_ADDRESS_ENV, BROKER_PROVIDERS_ENV, BROKER_SOCKET_ENV } from '../../../src/services/sandboxBridge.ts';

describe('brokeredProviderOverrides', () => {
  it('routes through the loopback bridge when the broker is a mounted socket', () => {
    const overrides = brokeredProviderOverrides({
      [BROKER_PROVIDERS_ENV]: 'anthropic,openai',
      [BROKER_SOCKET_ENV]: '/run/doompi/broker.sock',
    });

    expect(overrides).toEqual([
      { provider: 'anthropic', baseUrl: 'http://127.0.0.1:8317/anthropic' },
      { provider: 'openai', baseUrl: 'http://127.0.0.1:8317/openai' },
    ]);
  });

  it('addresses a broker on a host port directly, with no bridge in the way', () => {
    const overrides = brokeredProviderOverrides({
      [BROKER_PROVIDERS_ENV]: 'anthropic',
      [BROKER_ADDRESS_ENV]: 'host.docker.internal:54321',
    });

    expect(overrides).toEqual([{ provider: 'anthropic', baseUrl: 'http://host.docker.internal:54321/anthropic' }]);
  });

  it('overrides nothing outside a brokered sandbox', () => {
    expect(brokeredProviderOverrides({})).toEqual([]);
    expect(brokeredProviderOverrides({ [BROKER_PROVIDERS_ENV]: '  ' })).toEqual([]);
  });

  it('overrides nothing when no route was granted', () => {
    expect(brokeredProviderOverrides({ [BROKER_PROVIDERS_ENV]: 'anthropic' })).toEqual([]);
  });

  it('tolerates padded and empty entries in the launch variable', () => {
    const overrides = brokeredProviderOverrides({
      [BROKER_PROVIDERS_ENV]: ' anthropic , ,groq ',
      [BROKER_ADDRESS_ENV]: 'host.docker.internal:9',
    });

    expect(overrides.map((override) => override.provider)).toEqual(['anthropic', 'groq']);
  });
});
