import { describe, expect, it } from 'vitest';
import {
  isDevProxyPath,
  parseProxyPath,
  validateTargetName,
  validateTargetPort,
} from '../../src/services/devProxyPolicy.ts';

const HUB_PORT = 7433;
const TUNNEL_PORT = 51_234;
const RESERVED = [HUB_PORT, TUNNEL_PORT];

describe('validateTargetName', () => {
  it('accepts a lowercase slug and normalizes surrounding space and case', () => {
    expect(validateTargetName('  StoreFront  ')).toEqual({ ok: true, name: 'storefront' });
    expect(validateTargetName('app-2')).toEqual({ ok: true, name: 'app-2' });
  });

  it('refuses anything that would need escaping in a path or a base option', () => {
    for (const candidate of ['', '-leading', 'has space', 'has/slash', 'has.dot', 'UPPER%2F', 'a'.repeat(33)]) {
      expect(validateTargetName(candidate).ok).toBe(false);
    }
  });

  it('refuses a value that is not text', () => {
    expect(validateTargetName(3000).ok).toBe(false);
    expect(validateTargetName(undefined).ok).toBe(false);
  });
});

describe('validateTargetPort', () => {
  it('accepts a port in range', () => {
    expect(validateTargetPort(3000, RESERVED)).toEqual({ ok: true, port: 3000 });
    expect(validateTargetPort('5173', RESERVED)).toEqual({ ok: true, port: 5173 });
  });

  it('refuses values that are not whole numbers in range', () => {
    for (const candidate of [0, -1, 1.5, 65_536, Number.NaN, 'vite', undefined]) {
      expect(validateTargetPort(candidate, RESERVED).ok).toBe(false);
    }
  });

  it("refuses the cockpit's own ports so the proxy cannot point at the cockpit", () => {
    expect(validateTargetPort(HUB_PORT, RESERVED).ok).toBe(false);
    expect(validateTargetPort(TUNNEL_PORT, RESERVED).ok).toBe(false);
  });

  it('ignores an undefined reserved entry, which is how an unbound tunnel reports itself', () => {
    expect(validateTargetPort(3000, [HUB_PORT, undefined])).toEqual({ ok: true, port: 3000 });
  });
});

describe('parseProxyPath', () => {
  it('names the target while leaving the path alone', () => {
    // The prefix stays on. The target is configured with a matching `base` and
    // believes it serves there, so handing it `/` would take its redirect back
    // to the base and loop.
    expect(parseProxyPath('/devproxy/storefront/')).toEqual({
      kind: 'match',
      name: 'storefront',
      upstreamPath: '/devproxy/storefront/',
    });
    expect(parseProxyPath('/devproxy/storefront/@vite/client')).toEqual({
      kind: 'match',
      name: 'storefront',
      upstreamPath: '/devproxy/storefront/@vite/client',
    });
  });

  it('keeps the encoding the browser sent, so an escaped filename still resolves', () => {
    expect(parseProxyPath('/devproxy/storefront/a%20b.png')).toEqual({
      kind: 'match',
      name: 'storefront',
      upstreamPath: '/devproxy/storefront/a%20b.png',
    });
  });

  it('redirects a bare target to its trailing slash', () => {
    expect(parseProxyPath('/devproxy/storefront')).toEqual({
      kind: 'redirect',
      location: '/devproxy/storefront/',
    });
  });

  it('refuses a path that climbs out of the prefix, encoded or not', () => {
    for (const candidate of [
      '/devproxy/storefront/../../api/sessions',
      '/devproxy/storefront/%2e%2e/%2e%2e/api/sessions',
      '/devproxy/storefront/a/./b',
    ]) {
      expect(parseProxyPath(candidate).kind).toBe('reject');
    }
  });

  it('refuses a malformed percent sequence rather than guessing', () => {
    expect(parseProxyPath('/devproxy/storefront/%zz').kind).toBe('reject');
  });

  it('refuses a prefix that only appears after decoding, so router and proxy agree', () => {
    expect(parseProxyPath('/%64evproxy/storefront/').kind).toBe('reject');
  });

  it('refuses a sibling path that merely starts with the same letters', () => {
    expect(parseProxyPath('/devproxyevil/storefront/').kind).toBe('reject');
  });

  it('refuses an unusable target name', () => {
    expect(parseProxyPath('/devproxy//main.js').kind).toBe('reject');
    expect(parseProxyPath('/devproxy/Store Front/x').kind).toBe('reject');
  });
});

/**
 * The remote guard and the proxy handler both call this, on strings that do
 * not always match: the router hands the guard a raw slice of the request
 * line, while the handler reads a pathname that has already had `..` resolved.
 * Anything this grants must therefore be unable to turn into an API path.
 */
describe('isDevProxyPath', () => {
  it('claims a well-formed proxied path', () => {
    expect(isDevProxyPath('/devproxy/storefront/')).toBe(true);
    expect(isDevProxyPath('/devproxy/storefront/@vite/client')).toBe(true);
    expect(isDevProxyPath('/devproxy/storefront/a%20b.png')).toBe(true);
  });

  it('disclaims anything carrying a dot segment, in either encoding', () => {
    for (const candidate of [
      '/devproxy/storefront/../../api/health',
      '/devproxy/storefront/%2e%2e/api/health',
      '/devproxy/storefront/./x',
      '/devproxy/../api/health',
    ]) {
      expect(isDevProxyPath(candidate)).toBe(false);
    }
  });

  it('disclaims a lookalike prefix and unrelated paths', () => {
    expect(isDevProxyPath('/devproxyevil/x')).toBe(false);
    expect(isDevProxyPath('/devproxy')).toBe(false);
    expect(isDevProxyPath('/api/sessions')).toBe(false);
    expect(isDevProxyPath('/')).toBe(false);
  });
});
