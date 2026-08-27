import { describe, expect, it } from 'vitest';
import { describeTunnelFailure, extractTunnelUrl, tunnelArgs } from '../../src/services/tunnelOutput.ts';
import { parseRemoteAccessSettings } from '../../src/services/remoteAccessSettings.ts';
import { localOriginPolicy, originVerdict, tunnelOriginPolicy } from '../../src/services/remoteGuardPolicy.ts';

describe('origin policy corners', () => {
  const local = localOriginPolicy(7433, ['https://my.dev.example', 'not a url']);
  const tunnel = tunnelOriginPolicy('https://doom.example.com', ['doom.example.com:8443']);

  it('honours an operator-supplied origin and drops one that is not a URL', () => {
    expect(local.origins.has('https://my.dev.example')).toBe(true);
    expect(local.origins.has('not a url')).toBe(false);
  });

  it('honours an operator-supplied host on the tunnel', () => {
    expect(tunnel.hosts.has('doom.example.com:8443')).toBe(true);
  });

  it('checks HEAD the same way it checks GET', () => {
    const verdict = originVerdict({
      listener: 'tunnel',
      method: 'HEAD',
      isUpgrade: false,
      origin: undefined,
      host: 'doom.example.com',
      local,
      tunnel,
    });
    expect(verdict).toBe('allow');
  });

  it('treats a lowercase method the same as an uppercase one', () => {
    const verdict = originVerdict({
      listener: 'tunnel',
      method: 'post',
      isUpgrade: false,
      origin: undefined,
      host: 'doom.example.com',
      local,
      tunnel,
    });
    expect(verdict).toBe('bad-origin');
  });
});

describe('settings parsing corners', () => {
  it('keeps a named tunnel that carries only a hostname', () => {
    const parsed = parseRemoteAccessSettings({
      version: 1,
      tunnel: { kind: 'named', hostname: 'doom.example.com' },
    });
    expect(parsed.settings.tunnel).toEqual({ kind: 'named', hostname: 'doom.example.com' });
  });

  it('drops empty optional strings rather than storing them', () => {
    const parsed = parseRemoteAccessSettings({
      version: 1,
      tunnel: { kind: 'named', hostname: 'doom.example.com', name: '', tokenFile: '', configFile: '' },
    });
    expect(parsed.settings.tunnel).toEqual({ kind: 'named', hostname: 'doom.example.com' });
  });

  it('refuses a tunnel block that is not an object', () => {
    const parsed = parseRemoteAccessSettings({ version: 1, tunnel: 'quick' });
    expect(parsed.settings.tunnel).toEqual({ kind: 'quick' });
    expect(parsed.warnings[0]).toContain('object');
  });

  it('refuses a value that is not finite', () => {
    const parsed = parseRemoteAccessSettings({ version: 1, idleMinutes: Number.NaN });
    expect(parsed.settings.idleMinutes).toBe(30);
    expect(parsed.warnings[0]).toContain('number');
  });
});

describe('tunnel output corners', () => {
  it('lowercases the hostname it extracts, so the origin check compares like with like', () => {
    expect(extractTunnelUrl('https://CALM-River.trycloudflare.com')).toBe('https://calm-river.trycloudflare.com');
  });

  it('omits the token flag when the file is missing', () => {
    expect(tunnelArgs({ kind: 'named', hostname: 'doom.example.com' }, 80)).not.toContain('--token');
  });

  it('omits an empty token rather than passing a blank flag', () => {
    expect(tunnelArgs({ kind: 'named', hostname: 'doom.example.com' }, 80, '')).not.toContain('--token');
  });

  it('describes a spawn failure and a timeout differently', () => {
    expect(describeTunnelFailure('spawn_failed')).not.toBe(describeTunnelFailure('timeout'));
  });
});
