import { BROKER_ADDRESS_ENV, BROKER_CONTAINER_PORT, BROKER_PROVIDERS_ENV, BROKER_SOCKET_ENV } from './sandboxBridge.ts';

export interface BrokeredProviderOverride {
  provider: string;
  baseUrl: string;
}

/**
 * Points brokered providers at whichever route the launch granted.
 *
 * Pi reads base URLs from package-internal provider data, so redirecting a
 * session means overriding the provider rather than setting an environment
 * variable. The credential is left alone: the launch already replaced it with
 * the session token the broker expects.
 *
 * A broker on a host port is addressed directly. Only a mounted socket needs
 * the loopback bridge, because no SDK can dial a socket path.
 */
export function brokeredProviderOverrides(
  environment: Readonly<Record<string, string | undefined>>,
): BrokeredProviderOverride[] {
  const configured = environment[BROKER_PROVIDERS_ENV]?.trim();
  if (!configured) return [];
  const authority = environment[BROKER_SOCKET_ENV]?.trim()
    ? `127.0.0.1:${BROKER_CONTAINER_PORT}`
    : environment[BROKER_ADDRESS_ENV]?.trim();
  if (!authority) return [];
  return configured
    .split(',')
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0)
    .map((provider) => ({ provider, baseUrl: `http://${authority}/${provider}` }));
}
