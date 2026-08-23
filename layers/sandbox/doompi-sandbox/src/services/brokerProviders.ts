import { BROKER_CONTAINER_PORT, BROKER_PROVIDERS_ENV } from './sandboxBridge.ts';

export interface BrokeredProviderOverride {
  provider: string;
  baseUrl: string;
}

/**
 * Points brokered providers at the in-container bridge.
 *
 * Pi reads base URLs from package-internal provider data, so redirecting a
 * session means overriding the provider rather than setting an environment
 * variable. The credential is left alone: the launch already replaced it with
 * the session token the broker expects.
 */
export function brokeredProviderOverrides(
  environment: Readonly<Record<string, string | undefined>>,
): BrokeredProviderOverride[] {
  const configured = environment[BROKER_PROVIDERS_ENV]?.trim();
  if (!configured) return [];
  return configured
    .split(',')
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0)
    .map((provider) => ({ provider, baseUrl: `http://127.0.0.1:${BROKER_CONTAINER_PORT}/${provider}` }));
}
