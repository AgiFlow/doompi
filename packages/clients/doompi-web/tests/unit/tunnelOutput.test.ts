import { describe, expect, it } from 'vitest';
import {
  describeTunnelFailure,
  extractTunnelUrl,
  mentionsRegisteredConnection,
  tunnelArgs,
  tunnelTarget,
} from '../../src/services/tunnelOutput.ts';

describe('extractTunnelUrl', () => {
  it('finds the URL inside cloudflared banner output', () => {
    const banner = [
      'INF Requesting new quick Tunnel on trycloudflare.com...',
      'INF +--------------------------------------------+',
      'INF |  https://calm-river-1234.trycloudflare.com  |',
      'INF +--------------------------------------------+',
    ].join('\n');
    expect(extractTunnelUrl(banner)).toBe('https://calm-river-1234.trycloudflare.com');
  });

  it('finds a URL printed mid-stream with no banner', () => {
    expect(extractTunnelUrl('some noise https://a-b-c.trycloudflare.com more noise')).toBe(
      'https://a-b-c.trycloudflare.com',
    );
  });

  it.each([
    ['https://evil.trycloudflare.com.attacker.tld', 'a suffixed lookalike'],
    ['https://trycloudflare.com.attacker.tld', 'a bare lookalike'],
    ['https://x.trycloudflare.com.evil.tld/path', 'a lookalike with a path'],
    ['http://x.trycloudflare.com', 'a plaintext one'],
  ])('refuses %s (%s)', (text) => {
    // A match here becomes the origin the guard trusts for every later request,
    // so a hostname that only ends near a real one has to be rejected.
    expect(extractTunnelUrl(text)).toBeUndefined();
  });

  it('still extracts a real hostname embedded in surrounding text', () => {
    // Not a hole: what comes back is a genuine trycloudflare origin, so the
    // worst case is the wrong tunnel rather than an attacker's domain, and the
    // self-test refuses to come up against a tunnel that is not ours.
    expect(extractTunnelUrl('https://attacker.tld/https://x.trycloudflare.com')).toBe('https://x.trycloudflare.com');
  });

  it('finds nothing in output that carries no URL', () => {
    expect(extractTunnelUrl('INF Starting tunnel')).toBeUndefined();
  });
});

describe('mentionsRegisteredConnection', () => {
  it('recognises the readiness line', () => {
    expect(mentionsRegisteredConnection('INF Registered tunnel connection connIndex=0')).toBe(true);
  });

  it('does not treat a request line as readiness', () => {
    expect(mentionsRegisteredConnection('INF Requesting new quick Tunnel')).toBe(false);
  });
});

describe('tunnelArgs', () => {
  it('builds a quick tunnel with no subcommand', () => {
    expect(tunnelArgs({ kind: 'quick' }, 8123)).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--url',
      'http://127.0.0.1:8123',
    ]);
  });

  it('runs a named tunnel and passes its token', () => {
    expect(tunnelArgs({ kind: 'named', hostname: 'doom.example.com', name: 'doom' }, 8123, 'secret')).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--url',
      'http://127.0.0.1:8123',
      'run',
      '--token',
      'secret',
      'doom',
    ]);
  });

  it('places a config file before the subcommand', () => {
    expect(tunnelArgs({ kind: 'named', hostname: 'doom.example.com', configFile: '/tmp/c.yml' }, 80)).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--config',
      '/tmp/c.yml',
      '--url',
      'http://127.0.0.1:80',
      'run',
    ]);
  });

  it('always targets loopback rather than any address', () => {
    expect(tunnelTarget(1234)).toBe('http://127.0.0.1:1234');
  });
});

describe('mentionsRegisteredConnection variants', () => {
  it('recognises the alternative wording cloudflared uses', () => {
    expect(mentionsRegisteredConnection('Connection abc123 registered with the edge')).toBe(true);
  });
});

describe('describeTunnelFailure', () => {
  it('tells the operator what to do about a missing binary', () => {
    expect(describeTunnelFailure('not_installed')).toContain('brew install cloudflared');
  });

  it('has copy for every failure', () => {
    for (const failure of ['not_installed', 'spawn_failed', 'timeout', 'self_test_failed', 'exited'] as const) {
      expect(describeTunnelFailure(failure).length).toBeGreaterThan(0);
    }
  });
});
