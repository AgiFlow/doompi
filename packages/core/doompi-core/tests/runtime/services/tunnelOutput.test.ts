import { describe, expect, it } from 'vitest';

import {
  describeTunnelFailure,
  extractTunnelUrl,
  mentionsRegisteredConnection,
  tunnelArgs,
  tunnelTarget,
} from '../../../src/services/tunnelOutput';

describe('cloudflared output and arguments', () => {
  it('builds quick and named commands with the flags on their owning subcommands', () => {
    expect(tunnelTarget(4912)).toBe('http://127.0.0.1:4912');
    expect(tunnelArgs({ kind: 'quick' }, 4912)).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--url',
      'http://127.0.0.1:4912',
    ]);
    expect(tunnelArgs({ kind: 'named', hostname: 'remote.example.com' }, 4912)).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--url',
      'http://127.0.0.1:4912',
      'run',
    ]);
    expect(
      tunnelArgs(
        { kind: 'named', hostname: 'remote.example.com', name: 'home', configFile: '/config' },
        4912,
        '/token',
      ),
    ).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--config',
      '/config',
      '--url',
      'http://127.0.0.1:4912',
      'run',
      '--token-file',
      '/token',
      'home',
    ]);
    expect(tunnelArgs({ kind: 'named', hostname: 'remote.example.com' }, 4912, '')).not.toContain('--token-file');
  });

  it('accepts only a complete trycloudflare origin and a registered connection', () => {
    expect(extractTunnelUrl('Visit HTTPS://AbC.trycloudflare.com/pair')).toBe('https://abc.trycloudflare.com');
    expect(extractTunnelUrl('https://evil.trycloudflare.com.attacker.tld')).toBeUndefined();
    expect(extractTunnelUrl('https://evil.trycloudflare.com-other')).toBeUndefined();
    expect(extractTunnelUrl('unrelated output')).toBeUndefined();
    expect(mentionsRegisteredConnection('Registered tunnel connection')).toBe(true);
    expect(mentionsRegisteredConnection('Connection 1 registered')).toBe(true);
    expect(mentionsRegisteredConnection('waiting for connection')).toBe(false);
  });

  it('describes each launch failure', () => {
    for (const failure of ['not_installed', 'spawn_failed', 'timeout', 'self_test_failed', 'exited'] as const) {
      expect(describeTunnelFailure(failure)).toBeTruthy();
    }
  });
});
