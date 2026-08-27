import { describe, expect, it } from 'vitest';
import {
  PUBLIC_PAIRING_ROUTES,
  allowedOriginsFromEnv,
  isPublicPairingRoute,
  listenerOf,
  localOriginPolicy,
  originVerdict,
  tunnelOriginPolicy,
  type OriginVerdictInput,
} from '../../src/services/remoteGuardPolicy.ts';

const HUB_PORT = 7433;
const TUNNEL_ORIGIN = 'https://calm-river-1234.trycloudflare.com';

const local = localOriginPolicy(HUB_PORT);
const tunnel = tunnelOriginPolicy(TUNNEL_ORIGIN);

function verdict(overrides: Partial<OriginVerdictInput>): string {
  return originVerdict({
    listener: 'local',
    method: 'GET',
    isUpgrade: false,
    origin: undefined,
    host: `127.0.0.1:${String(HUB_PORT)}`,
    local,
    tunnel,
    ...overrides,
  });
}

describe('listenerOf', () => {
  it('calls a request local only when the socket port provably matches the loopback listener', () => {
    expect(listenerOf(HUB_PORT, HUB_PORT)).toBe('local');
  });

  it('treats a different socket port as tunnel traffic', () => {
    expect(listenerOf(54321, HUB_PORT)).toBe('tunnel');
  });

  it('fails closed when the socket port cannot be read', () => {
    expect(listenerOf(undefined, HUB_PORT)).toBe('tunnel');
  });

  it('fails closed before the loopback listener has bound', () => {
    expect(listenerOf(HUB_PORT, undefined)).toBe('tunnel');
    expect(listenerOf(undefined, undefined)).toBe('tunnel');
  });
});

describe('isPublicPairingRoute', () => {
  it('allows exactly the five unauthenticated routes and no more', () => {
    // Pinned on purpose: an addition here widens the public surface of a
    // cockpit that can run shell commands, and should not pass unnoticed.
    expect(PUBLIC_PAIRING_ROUTES).toHaveLength(5);
    expect(isPublicPairingRoute('GET', '/pair')).toBe(true);
    expect(isPublicPairingRoute('POST', '/api/remote/pair')).toBe(true);
    expect(isPublicPairingRoute('GET', '/api/remote/pair/status')).toBe(true);
    // Sign-in must be reachable without a session; that is what signing in is.
    expect(isPublicPairingRoute('POST', '/api/remote/passkeys/authenticate/begin')).toBe(true);
    expect(isPublicPairingRoute('POST', '/api/remote/passkeys/authenticate/finish')).toBe(true);
  });

  it('does not expose passkey enrolment, which is granting access rather than proving it', () => {
    expect(isPublicPairingRoute('POST', '/api/remote/passkeys/register/begin')).toBe(false);
    expect(isPublicPairingRoute('POST', '/api/remote/passkeys/register/finish')).toBe(false);
    expect(isPublicPairingRoute('GET', '/api/remote/passkeys')).toBe(false);
  });

  it('refuses a pairing route reached with the wrong method', () => {
    expect(isPublicPairingRoute('POST', '/pair')).toBe(false);
    expect(isPublicPairingRoute('GET', '/api/remote/pair')).toBe(false);
    expect(isPublicPairingRoute('DELETE', '/api/remote/pair/status')).toBe(false);
  });

  it('refuses every near miss of the pairing path', () => {
    for (const path of [
      '/pair/',
      '/pairx',
      '//pair',
      '/PAIR',
      '/pair;x=1',
      '/./pair',
      '/pair/../api/health',
      '/api/remote/pair/status/',
      '/api/remote/pair/status/../../health',
      '/api/health',
      '/',
    ]) {
      expect(isPublicPairingRoute('GET', path), path).toBe(false);
    }
  });

  it('allows a percent-encoded path because that is where the router sends it', () => {
    // Hono routes on a decoded path, so the guard must decide on the same
    // value. Deciding on a raw pathname would let the two disagree.
    expect(isPublicPairingRoute('GET', decodeURIComponent('/%70air'))).toBe(true);
  });
});

describe('allowedOriginsFromEnv', () => {
  it('reads a comma-separated list and drops the blanks', () => {
    expect(allowedOriginsFromEnv('https://a.test, https://b.test ,, ')).toEqual(['https://a.test', 'https://b.test']);
  });

  it('adds nothing when the variable is unset or empty', () => {
    expect(allowedOriginsFromEnv(undefined)).toEqual([]);
    expect(allowedOriginsFromEnv('')).toEqual([]);
    expect(allowedOriginsFromEnv('  ')).toEqual([]);
  });
});

describe('originVerdict on the loopback listener', () => {
  it('allows a request with no Origin so non-browser clients keep working', () => {
    expect(verdict({ origin: undefined })).toBe('allow');
  });

  it('allows a request with no Origin even when it mutates', () => {
    expect(verdict({ origin: undefined, method: 'POST' })).toBe('allow');
    expect(verdict({ origin: undefined, isUpgrade: true })).toBe('allow');
  });

  it('allows every spelling of the loopback origin', () => {
    for (const origin of [
      `http://127.0.0.1:${String(HUB_PORT)}`,
      `http://localhost:${String(HUB_PORT)}`,
      `http://[::1]:${String(HUB_PORT)}`,
    ]) {
      expect(verdict({ origin }), origin).toBe('allow');
    }
  });

  it('allows the vite dev server, whose proxy forwards its own Host and Origin', () => {
    expect(verdict({ origin: 'http://localhost:7434', host: 'localhost:7434' })).toBe('allow');
    expect(verdict({ origin: 'http://127.0.0.1:7434', host: '127.0.0.1:7434' })).toBe('allow');
  });

  it('normalizes case and a trailing slash before comparing', () => {
    expect(verdict({ origin: `HTTP://LOCALHOST:${String(HUB_PORT)}` })).toBe('allow');
    expect(verdict({ origin: `http://localhost:${String(HUB_PORT)}/` })).toBe('allow');
  });

  it('refuses a hostile origin, which is the cross-site socket hijack', () => {
    expect(verdict({ origin: 'http://evil.com', isUpgrade: true })).toBe('bad-origin');
  });

  it('refuses the opaque null origin sent by sandboxed frames', () => {
    expect(verdict({ origin: 'null' })).toBe('bad-origin');
  });

  it('refuses a loopback origin on some other port', () => {
    expect(verdict({ origin: 'http://localhost:9999' })).toBe('bad-origin');
  });

  it('refuses a non-loopback Host, which is the DNS rebinding defence', () => {
    expect(verdict({ host: 'evil.com', origin: undefined })).toBe('bad-host');
    expect(verdict({ host: undefined, origin: undefined })).toBe('bad-host');
  });
});

describe('originVerdict on the tunnel listener', () => {
  const onTunnel = (overrides: Partial<OriginVerdictInput>): string =>
    verdict({ listener: 'tunnel', host: 'calm-river-1234.trycloudflare.com', ...overrides });

  it('allows a plain navigation with no Origin so a scanned link opens', () => {
    expect(onTunnel({ origin: undefined })).toBe('allow');
  });

  it('requires an Origin on anything with a side effect', () => {
    expect(onTunnel({ origin: undefined, method: 'POST' })).toBe('bad-origin');
    expect(onTunnel({ origin: undefined, isUpgrade: true })).toBe('bad-origin');
  });

  it('allows its own origin', () => {
    expect(onTunnel({ origin: TUNNEL_ORIGIN, isUpgrade: true })).toBe('allow');
  });

  it('accepts the forwarded Host with or without the default port', () => {
    expect(onTunnel({ host: 'calm-river-1234.trycloudflare.com:443', origin: TUNNEL_ORIGIN })).toBe('allow');
  });

  it('refuses origins that merely contain the tunnel hostname', () => {
    for (const origin of [
      'https://calm-river-1234.trycloudflare.com.attacker.tld',
      'https://attacker.tld/calm-river-1234.trycloudflare.com',
      'https://calm-river-1234.trycloudflare.com:8443',
      'http://calm-river-1234.trycloudflare.com',
    ]) {
      expect(onTunnel({ origin, isUpgrade: true }), origin).toBe('bad-origin');
    }
  });

  it('refuses a Host that is not the tunnel, including a forged loopback Host', () => {
    expect(onTunnel({ host: `127.0.0.1:${String(HUB_PORT)}`, origin: TUNNEL_ORIGIN })).toBe('bad-host');
  });

  it('serves nothing at all before the tunnel has named itself', () => {
    expect(
      originVerdict({
        listener: 'tunnel',
        method: 'GET',
        isUpgrade: false,
        origin: undefined,
        host: 'calm-river-1234.trycloudflare.com',
        local,
        tunnel: undefined,
      }),
    ).toBe('not-ready');
  });
});

describe('tunnelOriginPolicy', () => {
  it('rejects a public origin that is not a URL rather than trusting it', () => {
    expect(() => tunnelOriginPolicy('not-a-url')).toThrow(/not a URL/u);
  });
});
