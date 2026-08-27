import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteAccessStore, defaultRemoteStateDir } from '../../src/adapters/remoteAccessStore.ts';
import { DEFAULT_REMOTE_SETTINGS } from '../../src/services/remoteAccessSettings.ts';
import type { StoredCredential } from '../../src/services/webauthnPolicy.ts';

let stateDir: string;
let notices: string[];

function open() {
  return createRemoteAccessStore({ stateDir, onNotice: (message) => notices.push(message) });
}

function credential(id: string): StoredCredential {
  return {
    id,
    credentialId: `cred-${id}`,
    publicKey: 'AAAA',
    counter: 0,
    transports: ['internal'],
    label: 'iPhone',
    createdAt: 1,
    lastUsedAt: 1,
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-remote-store-'));
  notices = [];
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('settings on disk', () => {
  it('starts on defaults without complaining, because a first run has no file', () => {
    expect(open().settings()).toEqual(DEFAULT_REMOTE_SETTINGS);
    expect(notices).toEqual([]);
  });

  it('round-trips what it saved across a restart', () => {
    open().save({ ...DEFAULT_REMOTE_SETTINGS, autoCloseEnabled: true, idleMinutes: 45 });
    expect(open().settings()).toMatchObject({ autoCloseEnabled: true, idleMinutes: 45 });
  });

  it('writes owner-only, in a directory nobody else can list', () => {
    open().save(DEFAULT_REMOTE_SETTINGS);
    expect(fs.statSync(path.join(stateDir, 'remote-access.json')).mode & 0o077).toBe(0);
    expect(fs.statSync(stateDir).mode & 0o077).toBe(0);
  });

  it('falls back on unreadable JSON and leaves the file alone', () => {
    // Silently overwriting a file somebody hand-edited is worse than ignoring
    // it for this run.
    const file = path.join(stateDir, 'remote-access.json');
    fs.writeFileSync(file, '{ not json');
    expect(open().settings()).toEqual(DEFAULT_REMOTE_SETTINGS);
    expect(notices.some((message) => message.includes('not valid JSON'))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('tightens a state file another account could read', () => {
    fs.writeFileSync(path.join(stateDir, 'remote-access.json'), '{}', { mode: 0o644 });
    open();
    expect(fs.statSync(path.join(stateDir, 'remote-access.json')).mode & 0o077).toBe(0);
    expect(notices.some((message) => message.includes('tightened'))).toBe(true);
  });
});

describe('passkeys on disk', () => {
  it('keeps registered credentials across a restart, which is their whole point', () => {
    const store = open();
    store.saveCredential(credential('a'));
    store.saveCredential(credential('b'));
    expect(
      open()
        .credentials()
        .map((held) => held.id),
    ).toEqual(['a', 'b']);
  });

  it('replaces a credential in place rather than duplicating it', () => {
    const store = open();
    store.saveCredential(credential('a'));
    store.saveCredential({ ...credential('a'), counter: 7 });
    expect(store.credentials()).toHaveLength(1);
    expect(store.credentials()[0]?.counter).toBe(7);
  });

  it('forgets one credential and reports whether it existed', () => {
    const store = open();
    store.saveCredential(credential('a'));
    expect(store.removeCredential('a')).toBe(true);
    expect(store.removeCredential('a')).toBe(false);
    expect(open().credentials()).toHaveLength(0);
  });

  it('writes passkeys owner-only too', () => {
    open().saveCredential(credential('a'));
    expect(fs.statSync(path.join(stateDir, 'credentials.json')).mode & 0o077).toBe(0);
  });

  it('fails closed on a corrupt credential file rather than guessing', () => {
    // Everyone re-enrols, which is recoverable; a partially trusted key set is not.
    fs.writeFileSync(path.join(stateDir, 'credentials.json'), 'not json');
    expect(open().credentials()).toEqual([]);
    expect(notices.some((message) => message.includes('not valid JSON'))).toBe(true);
  });

  it('ignores a credential file that is not a list', () => {
    fs.writeFileSync(path.join(stateDir, 'credentials.json'), '{"a":1}');
    expect(open().credentials()).toEqual([]);
  });
});

describe('defaultRemoteStateDir', () => {
  it('sits beside the bundle doompi sync already writes', () => {
    expect(defaultRemoteStateDir('/home/someone')).toBe('/home/someone/.doompi/web');
  });
});
