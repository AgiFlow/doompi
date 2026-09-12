import { BUNDLE_MANIFEST_ROUTE } from '@agimon-ai/doompi-web-security/browser';
import { DEV_PROXY_PREFIX } from '../types/devProxy';

/**
 * Which paths the service worker lets through to the network.
 *
 * Split out of the worker itself so it can be tested. The worker module reads
 * `self` at import time, which no test runner outside a worker scope can
 * satisfy, and a rule this consequential should not be untestable for that
 * reason.
 */

/** Signed bundle bytes, addressed by revision. */
export const RAW_BUNDLE_PREFIX = '/bundle-assets/';

/**
 * Paths answered from the network rather than from the verified bundle.
 *
 * Everything outside this list is served from the signed cache, so an entry
 * here is an entry whose bytes are not signature-checked. The list is short on
 * purpose and a contract test pins it.
 *
 * The dev proxy belongs here because the bytes it carries are somebody's dev
 * server: unsigned by definition, and different on every keystroke. That is
 * the trade recorded in docs/security.md, where the proxied application is
 * unsigned code sharing the cockpit's origin.
 */
export function trustedNetworkPath(pathname: string): boolean {
  return (
    pathname === '/pair' ||
    pathname === '/sw.js' ||
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/pwa/') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith(DEV_PROXY_PREFIX) ||
    pathname === BUNDLE_MANIFEST_ROUTE ||
    pathname.startsWith(RAW_BUNDLE_PREFIX)
  );
}
