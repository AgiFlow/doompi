/**
 * Fixed loopback ports Pi's OAuth flows listen on.
 *
 * A provider redirects the browser to `http://localhost:<port>`, so the host
 * port has to match exactly and cannot be remapped. Providers that bind an
 * ephemeral port instead, such as OpenRouter, cannot be published ahead of the
 * flow and are not covered.
 */
export const OAUTH_CALLBACK_PORTS: readonly number[] = [
  1455, // openai-codex
  1456, // radius
  53692, // anthropic
];

export const OAUTH_CALLBACK_HOST_ENV = 'PI_OAUTH_CALLBACK_HOST';

/**
 * Address the in-container callback server binds.
 *
 * Pi binds loopback by default, which a published port cannot reach: the
 * engine forwards to the container's external interface, not its loopback.
 * Only the bind address changes; the redirect the provider sees stays
 * `localhost`.
 */
export const OAUTH_CONTAINER_BIND = '0.0.0.0';

/** Publishes each reachable callback port back onto the host's loopback. */
export function oauthPublishArgs(ports: readonly number[]): string[] {
  return ports.flatMap((port) => ['-p', `127.0.0.1:${port}:${port}`]);
}
