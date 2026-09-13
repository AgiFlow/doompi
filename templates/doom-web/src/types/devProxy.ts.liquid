/**
 * Wire vocabulary for the dev-site reverse proxy, shared by the hub routes,
 * the cockpit, and the service worker.
 *
 * The cockpit proxies a developer's local HTTP server under a path prefix on
 * its own origin, the way nginx or Caddy would. That choice buys one thing
 * worth more than everything it costs: the request is already authenticated.
 * A paired device sends `__Host-doompi_device` on every same-origin path, so
 * the proxy needs no second hostname, no grant token, and no pairing ceremony
 * of its own.
 *
 * It also means the proxied application shares an origin with the cockpit, and
 * a sub-path deployment requires the application to know its base path. Both
 * are documented in docs/security.md rather than worked around here.
 *
 * This module holds constants and shapes only. `src/pwa` may import
 * `src/types` and nothing else from the server tree, and the service worker
 * needs the prefix, so the prefix has to live here.
 */

/** Control plane for listing and registering targets; registration is local-only. */
export const DEV_PROXY_API_ROUTE = '/api/dev-proxy';
export const DEV_PROXY_TARGETS_ROUTE = `${DEV_PROXY_API_ROUTE}/targets`;

/**
 * The path every proxied request lives under.
 *
 * Both slashes matter. The leading one anchors it at the root so no other
 * route can be shadowed, and the trailing one makes `startsWith` exact: a
 * request for `/devproxyevil` must not match, and without the trailing slash
 * it would.
 */
export const DEV_PROXY_PREFIX = '/devproxy/';

/**
 * A registered upstream.
 *
 * `name` rather than a generated id because it appears in the developer's own
 * build configuration as `base: '/devproxy/<name>/'`. A uuid would change
 * nothing functionally and would make that line unreadable and unmemorable.
 */
export interface DevProxyTarget {
  name: string;
  port: number;
  createdAt: number;
}

export interface DevProxyStateView {
  targets: readonly DevProxyTarget[];
  /** False on the tunnel listener, where registering a new target is refused. */
  canRegister: boolean;
}
