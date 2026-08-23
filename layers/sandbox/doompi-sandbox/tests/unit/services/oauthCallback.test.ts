import { describe, expect, it } from 'vitest';
import {
  OAUTH_CALLBACK_HOST_ENV,
  OAUTH_CALLBACK_PORTS,
  OAUTH_CONTAINER_BIND,
  oauthPublishArgs,
} from '../../../src/services/oauthCallback.ts';

describe('oauth callback contract', () => {
  it('covers the fixed ports Pi binds', () => {
    // A provider redirects to localhost:<port>, so these cannot be remapped.
    expect(OAUTH_CALLBACK_PORTS).toEqual([1455, 1456, 53692]);
  });

  it('binds every interface inside the container', () => {
    expect(OAUTH_CALLBACK_HOST_ENV).toBe('PI_OAUTH_CALLBACK_HOST');
    expect(OAUTH_CONTAINER_BIND).toBe('0.0.0.0');
  });
});

describe('oauthPublishArgs', () => {
  it('publishes each port back onto host loopback at the same number', () => {
    expect(oauthPublishArgs([1455, 53692])).toEqual(['-p', '127.0.0.1:1455:1455', '-p', '127.0.0.1:53692:53692']);
  });

  it('publishes nothing when no port is free', () => {
    expect(oauthPublishArgs([])).toEqual([]);
  });
});
