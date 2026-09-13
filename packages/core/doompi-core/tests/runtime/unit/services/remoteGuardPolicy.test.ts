import { describe, expect, it } from 'vitest';

import {
  allowedOriginsFromEnv,
  isPublicPairingRoute,
  listenerOf,
  localOriginPolicy,
  originVerdict,
  tunnelOriginPolicy,
} from '../../../../src/services/remoteGuardPolicy';

describe('remote guard policy', () => {
  it('treats uncertain sockets as tunnel traffic and matches only exact public routes', () => {
    expect(listenerOf(undefined, 3000)).toBe('tunnel');
    expect(listenerOf(3000, undefined)).toBe('tunnel');
    expect(listenerOf(3000, 3000)).toBe('local');
    expect(listenerOf(3001, 3000)).toBe('tunnel');
    expect(isPublicPairingRoute('get', '/pair')).toBe(true);
    expect(isPublicPairingRoute('POST', '/api/remote/pair')).toBe(true);
    expect(isPublicPairingRoute('GET', '/pair/extra')).toBe(false);
    expect(isPublicPairingRoute('DELETE', '/pair')).toBe(false);
    expect(allowedOriginsFromEnv(undefined)).toEqual([]);
    expect(allowedOriginsFromEnv(' http://localhost:3001, ,https://other.example.com ')).toEqual([
      'http://localhost:3001',
      'https://other.example.com',
    ]);
  });

  it('normalizes the local allowlist and checks Host even on read requests', () => {
    const local = localOriginPolicy(3000, ['HTTPS://EXAMPLE.COM/path', 'bad origin']);
    expect(local.hosts.has('localhost:3000')).toBe(true);
    expect(local.hosts.has('localhost:7434')).toBe(true);
    expect(local.origins.has('https://example.com')).toBe(true);
    const input = {
      listener: 'local' as const,
      method: 'GET',
      isUpgrade: false,
      origin: undefined,
      host: ' LOCALHOST:3000 ',
      local,
      tunnel: undefined,
    };
    expect(originVerdict(input)).toBe('allow');
    expect(originVerdict({ ...input, host: undefined })).toBe('bad-host');
    expect(originVerdict({ ...input, host: 'evil.example.com' })).toBe('bad-host');
    expect(originVerdict({ ...input, origin: 'null' })).toBe('bad-origin');
    expect(originVerdict({ ...input, origin: 'https://example.com/path' })).toBe('allow');
    expect(originVerdict({ ...input, origin: 'https://evil.example.com' })).toBe('bad-origin');
  });

  it('requires a ready tunnel policy and Origin on mutations or upgrades', () => {
    const local = localOriginPolicy(3000);
    const tunnel = tunnelOriginPolicy('https://ACCESS.EXAMPLE.COM', [' ALIAS.EXAMPLE.COM ']);
    expect(tunnel.hosts.has('access.example.com:443')).toBe(true);
    expect(tunnel.hosts.has('alias.example.com')).toBe(true);
    expect(() => tunnelOriginPolicy('not a url')).toThrow('not a URL');
    const input = {
      listener: 'tunnel' as const,
      method: 'GET',
      isUpgrade: false,
      origin: undefined,
      host: 'access.example.com',
      local,
      tunnel,
    };
    expect(originVerdict({ ...input, tunnel: undefined })).toBe('not-ready');
    expect(originVerdict(input)).toBe('allow');
    expect(originVerdict({ ...input, method: 'HEAD' })).toBe('allow');
    expect(originVerdict({ ...input, method: 'POST' })).toBe('bad-origin');
    expect(originVerdict({ ...input, isUpgrade: true })).toBe('bad-origin');
    expect(originVerdict({ ...input, method: 'POST', origin: 'https://access.example.com' })).toBe('allow');
    expect(originVerdict({ ...input, method: 'POST', origin: 'https://another.example.com' })).toBe('bad-origin');
  });
});
