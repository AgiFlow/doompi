import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HEADLESS_URL,
  headlessArguments,
  headlessEndpoint,
  ownsHeadlessProcess,
} from '../../src/services/headlessLaunch';

describe('headlessLaunch', () => {
  it('owns a headless process only when the caller named neither endpoint nor credential', () => {
    expect(ownsHeadlessProcess({})).toBe(true);
    expect(ownsHeadlessProcess({ headlessUrl: 'http://127.0.0.1:9000' })).toBe(false);
    expect(ownsHeadlessProcess({ headlessToken: 'secret' })).toBe(false);
  });

  it('reads the host and port of the default endpoint', () => {
    expect(headlessEndpoint(DEFAULT_HEADLESS_URL)).toEqual({ host: '127.0.0.1', port: 7434 });
  });

  it('defaults the port from the scheme when the URL omits it', () => {
    expect(headlessEndpoint('http://localhost')).toEqual({ host: 'localhost', port: 80 });
    expect(headlessEndpoint('https://localhost')).toEqual({ host: 'localhost', port: 443 });
  });

  it('rejects an endpoint the proxy cannot reach', () => {
    expect(() => headlessEndpoint('ws://127.0.0.1:7434')).toThrow(/HTTP or HTTPS/);
  });

  it('starts the headless process on the proxied port without opening a terminal session', () => {
    expect(headlessArguments({ entry: '/runtime/serve.mjs', port: 7434, tokenFile: '/tmp/token' })).toEqual([
      '/runtime/serve.mjs',
      '--auth-token-file',
      '/tmp/token',
      '--no-session',
      '--name',
      'DoomPi Web',
      '--web',
      '7434',
    ]);
  });
});
