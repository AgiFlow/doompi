import { describe, expect, it } from 'vitest';

import {
  HUB_ADVERTISEMENT_VERSION,
  hubAdvertisementPath,
  parseHubAdvertisement,
  parseSessionLineage,
  REGISTRY_DIR_ENV,
  resolveRegistryDir,
  SESSION_LINEAGE_RECORD_VERSION,
  sessionLineagePath,
} from '../../src/web/services/sessionRegistry';

describe('resolveRegistryDir', () => {
  it('prefers the flag, then the env, then the home default', () => {
    const homeDir = '/home/u';
    expect(resolveRegistryDir({ flagValue: '/flag', envValue: '/env', homeDir })).toBe('/flag');
    expect(resolveRegistryDir({ envValue: '/env', homeDir })).toBe('/env');
    expect(resolveRegistryDir({ homeDir })).toBe('/home/u/.doompi/run');
  });

  it('treats an empty string as absent, so a blank flag falls through', () => {
    expect(resolveRegistryDir({ flagValue: '', envValue: '/env', homeDir: '/home/u' })).toBe('/env');
    expect(resolveRegistryDir({ flagValue: '', envValue: '', homeDir: '/home/u' })).toBe('/home/u/.doompi/run');
  });

  it('names the env var the hub and its session servers share', () => {
    expect(REGISTRY_DIR_ENV).toBe('DOOMPI_RUNTIME_DIR');
  });
});

describe('sessionLineagePath', () => {
  it('sits beside the session record, under the registry sessions directory', () => {
    expect(sessionLineagePath('/run', 'abc')).toBe('/run/sessions/abc.lineage.json');
  });
});

describe('parseSessionLineage', () => {
  it('reads a well formed sidecar', () => {
    const raw = JSON.stringify({
      version: SESSION_LINEAGE_RECORD_VERSION,
      parentSessionId: 'parent-1',
      provenance: 'worktree',
    });
    expect(parseSessionLineage(raw)).toEqual({
      version: SESSION_LINEAGE_RECORD_VERSION,
      parentSessionId: 'parent-1',
      provenance: 'worktree',
    });
  });

  it('defaults a missing or non-string provenance to empty rather than failing', () => {
    const raw = JSON.stringify({ version: SESSION_LINEAGE_RECORD_VERSION, parentSessionId: 'p' });
    expect(parseSessionLineage(raw)?.provenance).toBe('');
    const numeric = JSON.stringify({ version: SESSION_LINEAGE_RECORD_VERSION, parentSessionId: 'p', provenance: 7 });
    expect(parseSessionLineage(numeric)?.provenance).toBe('');
  });

  // Every one of these means the same thing to a caller: no known parent. The
  // sidecar is written by a separate process that may be mid-write or newer.
  it.each([
    ['not json at all', 'not json'],
    ['a torn write', '{"version":1,"parentSess'],
    ['a json literal rather than an object', '42'],
    ['null', 'null'],
    ['an unknown version', '{"version":2,"parentSessionId":"p","provenance":"worktree"}'],
    ['a missing version', '{"parentSessionId":"p","provenance":"worktree"}'],
    ['a missing parent', '{"version":1,"provenance":"worktree"}'],
    ['a blank parent', '{"version":1,"parentSessionId":"","provenance":"worktree"}'],
    ['a non-string parent', '{"version":1,"parentSessionId":5,"provenance":"worktree"}'],
  ])('returns undefined for %s', (_label, raw) => {
    expect(parseSessionLineage(raw)).toBeUndefined();
  });
});

describe('hubAdvertisementPath', () => {
  it('sits at the registry root, beside the sessions directory', () => {
    expect(hubAdvertisementPath('/run/doompi')).toBe('/run/doompi/hub.json');
  });
});

describe('parseHubAdvertisement', () => {
  it('reads a well-formed advertisement', () => {
    expect(parseHubAdvertisement('{"version":1,"url":"http://127.0.0.1:4300","pid":42}')).toEqual({
      version: HUB_ADVERTISEMENT_VERSION,
      url: 'http://127.0.0.1:4300',
      pid: 42,
    });
  });

  it.each([
    ['localhost', 'http://localhost:4300'],
    ['the ipv6 loopback', 'http://[::1]:4300'],
  ])('accepts %s', (_label, url) => {
    expect(parseHubAdvertisement(JSON.stringify({ version: 1, url, pid: 42 }))?.url).toBe(url);
  });

  // The file names an address another process is told to POST a session-create
  // to, so anything that can write the registry directory could otherwise
  // redirect that call to a host of its choosing.
  it.each([
    ['a routable host', 'http://10.0.0.5:4300'],
    ['a public host', 'http://evil.example.com/'],
    ['https, which the local listener never speaks', 'https://127.0.0.1:4300'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a host that merely looks loopback', 'http://127.0.0.1.evil.com/'],
  ])('refuses %s', (_label, url) => {
    expect(parseHubAdvertisement(JSON.stringify({ version: 1, url, pid: 42 }))).toBeUndefined();
  });

  it.each([
    ['not json at all', 'not json'],
    ['a torn write', '{"version":1,"url":"http://127.0'],
    ['a json literal rather than an object', '42'],
    ['null', 'null'],
    ['an unknown version', '{"version":2,"url":"http://127.0.0.1:4300","pid":42}'],
    ['a missing url', '{"version":1,"pid":42}'],
    ['a non-string url', '{"version":1,"url":5,"pid":42}'],
    ['an unparseable url', '{"version":1,"url":"::::","pid":42}'],
    ['a missing pid', '{"version":1,"url":"http://127.0.0.1:4300"}'],
    ['a non-integer pid', '{"version":1,"url":"http://127.0.0.1:4300","pid":1.5}'],
    ['a non-positive pid', '{"version":1,"url":"http://127.0.0.1:4300","pid":0}'],
  ])('returns undefined for %s', (_label, raw) => {
    expect(parseHubAdvertisement(raw)).toBeUndefined();
  });
});
