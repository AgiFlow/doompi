import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMOTE_SETTINGS,
  REMOTE_SETTINGS_VERSION,
  parseRemoteAccessSettings,
  serializeRemoteAccessSettings,
} from '../../src/services/remoteAccessSettings.ts';

function stored(overrides: Record<string, unknown> = {}): unknown {
  return { ...(serializeRemoteAccessSettings(DEFAULT_REMOTE_SETTINGS) as object), ...overrides };
}

describe('parseRemoteAccessSettings', () => {
  it('falls back to defaults for a missing or unusable file', () => {
    for (const raw of [undefined, null, 'not json', 42, []]) {
      expect(parseRemoteAccessSettings(raw).settings).toEqual(DEFAULT_REMOTE_SETTINGS);
    }
  });

  it('says nothing about a file that simply is not there', () => {
    // First run is normal and should not produce a warning the user has to read.
    expect(parseRemoteAccessSettings(undefined).warnings).toEqual([]);
  });

  it('round-trips what it wrote', () => {
    const parsed = parseRemoteAccessSettings(serializeRemoteAccessSettings(DEFAULT_REMOTE_SETTINGS));
    expect(parsed.settings).toEqual(DEFAULT_REMOTE_SETTINGS);
    expect(parsed.warnings).toEqual([]);
  });

  it('refuses a version it does not understand rather than guessing', () => {
    const parsed = parseRemoteAccessSettings({ ...(stored() as object), version: REMOTE_SETTINGS_VERSION + 1 });
    expect(parsed.settings).toEqual(DEFAULT_REMOTE_SETTINGS);
    expect(parsed.warnings[0]).toContain('version');
  });

  it('clamps a value outside its bounds and says so', () => {
    const parsed = parseRemoteAccessSettings(stored({ autoCloseMinutes: 99_999, idleMinutes: 0, absoluteHours: -5 }));
    expect(parsed.settings.autoCloseMinutes).toBe(1440);
    expect(parsed.settings.idleMinutes).toBe(1);
    expect(parsed.settings.absoluteHours).toBe(1);
    expect(parsed.warnings).toHaveLength(3);
  });

  it('falls back per field rather than discarding the whole file', () => {
    const parsed = parseRemoteAccessSettings(stored({ autoCloseEnabled: 'yes', idleMinutes: 45 }));
    expect(parsed.settings.autoCloseEnabled).toBe(DEFAULT_REMOTE_SETTINGS.autoCloseEnabled);
    expect(parsed.settings.idleMinutes).toBe(45);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('keeps a complete named tunnel', () => {
    const tunnel = { kind: 'named', hostname: 'doom.example.com', tokenFile: '/tmp/token', name: 'doom' };
    expect(parseRemoteAccessSettings(stored({ tunnel })).settings.tunnel).toEqual(tunnel);
  });

  it('refuses a named tunnel with no hostname instead of silently downgrading it', () => {
    // Falling back quietly would swap a stable origin for a rotating one, which
    // breaks passkeys and durable pairing without telling anybody.
    const parsed = parseRemoteAccessSettings(stored({ tunnel: { kind: 'named' } }));
    expect(parsed.settings.tunnel).toEqual({ kind: 'quick' });
    expect(parsed.warnings[0]).toContain('hostname');
  });

  it('drops a tunnel kind it does not recognise', () => {
    const parsed = parseRemoteAccessSettings(stored({ tunnel: { kind: 'ngrok' } }));
    expect(parsed.settings.tunnel).toEqual({ kind: 'quick' });
    expect(parsed.warnings).toHaveLength(1);
  });
});

describe('the container settings', () => {
  it('defaults to off with nothing mounted, so containment is always a choice', () => {
    expect(parseRemoteAccessSettings(stored({})).settings.sandbox).toEqual({ enabled: false, workspaces: [] });
  });

  it('keeps absolute workspace paths in the order they were given', () => {
    const sandbox = { enabled: true, workspaces: ['/b', '/a'] };
    expect(parseRemoteAccessSettings(stored({ sandbox })).settings.sandbox).toEqual(sandbox);
  });

  it('refuses a relative path, which would mount somewhere other than it reads', () => {
    // Resolved inside the container it would name a different directory
    // entirely, and the mount would silently point at the wrong tree.
    const parsed = parseRemoteAccessSettings(stored({ sandbox: { enabled: true, workspaces: ['repo'] } }));
    expect(parsed.settings.sandbox.workspaces).toEqual([]);
    expect(parsed.warnings[0]).toContain('absolute');
  });

  it('refuses a workspace that is not a string at all', () => {
    const parsed = parseRemoteAccessSettings(stored({ sandbox: { enabled: true, workspaces: [7] } }));
    expect(parsed.settings.sandbox.workspaces).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('mounts a repeated directory once', () => {
    const parsed = parseRemoteAccessSettings(stored({ sandbox: { enabled: true, workspaces: ['/a', '/a'] } }));
    expect(parsed.settings.sandbox.workspaces).toEqual(['/a']);
  });

  it('ignores a workspace list that is not a list', () => {
    const parsed = parseRemoteAccessSettings(stored({ sandbox: { enabled: true, workspaces: '/a' } }));
    expect(parsed.settings.sandbox).toEqual({ enabled: true, workspaces: [] });
  });

  it('falls back to uncontained when the whole section is malformed', () => {
    const parsed = parseRemoteAccessSettings(stored({ sandbox: 'yes' }));
    expect(parsed.settings.sandbox).toEqual({ enabled: false, workspaces: [] });
    expect(parsed.warnings[0]).toContain('sandbox');
  });
});
