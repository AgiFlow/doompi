import { describe, expect, it } from 'vitest';
import { trustedNetworkPath } from '../../src/pwa/networkPaths';

/**
 * The service worker answers everything else from the signed bundle cache, so
 * this list is the exact set of paths whose bytes are not signature-checked.
 * It had no coverage before the dev proxy needed an entry; pinning it here
 * makes the next addition a deliberate one.
 */
describe('trustedNetworkPath', () => {
  it('passes the pairing and PWA bootstrap paths to the network', () => {
    for (const pathname of [
      '/pair',
      '/sw.js',
      '/manifest.webmanifest',
      '/pwa/pwa.js',
      '/pwa/icon-192.png',
      '/api/sessions',
      '/bundle-assets/main.js',
    ]) {
      expect(trustedNetworkPath(pathname)).toBe(true);
    }
  });

  it('passes proxied dev-site paths to the network', () => {
    expect(trustedNetworkPath('/devproxy/storefront/')).toBe(true);
    expect(trustedNetworkPath('/devproxy/storefront/@vite/client')).toBe(true);
  });

  it('keeps the cockpit shell on the signed bundle', () => {
    for (const pathname of ['/', '/index.html', '/assets/cockpit.js', '/session/abc', '/settings']) {
      expect(trustedNetworkPath(pathname)).toBe(false);
    }
  });

  it('does not treat a lookalike prefix as proxied', () => {
    expect(trustedNetworkPath('/devproxyevil/steal.js')).toBe(false);
    expect(trustedNetworkPath('/devproxy')).toBe(false);
  });
});
