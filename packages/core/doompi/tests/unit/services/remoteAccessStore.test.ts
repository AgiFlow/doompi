import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteAccessStore, defaultRemoteStateDir } from '../../../src/services/remoteAccessStore';
import { DEFAULT_REMOTE_SETTINGS } from '../../../src/services/remoteAccessSettings';
import type { StoredCredential } from '../../../src/services/webauthnPolicy';

const directories: string[] = [];
function directory(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-remote-store-'));
  directories.push(result);
  return result;
}
afterEach(() => {
  for (const target of directories.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

const credential: StoredCredential = {
  id: 'key-1',
  credentialId: 'opaque',
  publicKey: 'AQI',
  counter: 0,
  transports: [],
  label: 'Phone',
  createdAt: 1,
  lastUsedAt: 1,
};

describe('remote access store', () => {
  it('starts with defaults and atomically persists settings and passkeys', () => {
    const stateDir = directory();
    expect(defaultRemoteStateDir('/home/operator')).toBe('/home/operator/.doompi/web');
    const store = createRemoteAccessStore({ stateDir });
    expect(store.settings()).toEqual(DEFAULT_REMOTE_SETTINGS);
    expect(store.credentials()).toEqual([]);
    store.save({ ...DEFAULT_REMOTE_SETTINGS, sessionExpiryEnabled: true });
    store.saveCredential(credential);
    store.saveCredential({ ...credential, label: 'New label' });
    expect(store.credentials()).toEqual([{ ...credential, label: 'New label' }]);
    expect(fs.statSync(path.join(stateDir, 'remote-access.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(stateDir, 'credentials.json')).mode & 0o777).toBe(0o600);
    expect(createRemoteAccessStore({ stateDir }).settings().sessionExpiryEnabled).toBe(true);
    expect(createRemoteAccessStore({ stateDir }).credentials()).toEqual([{ ...credential, label: 'New label' }]);
    expect(store.removeCredential('missing')).toBe(false);
    expect(store.removeCredential('key-1')).toBe(true);
    expect(store.credentials()).toEqual([]);
  });

  it('repairs permissive files and falls back safely on malformed content', () => {
    const stateDir = directory();
    const notice = vi.fn();
    const settingsPath = path.join(stateDir, 'remote-access.json');
    const credentialsPath = path.join(stateDir, 'credentials.json');
    fs.writeFileSync(settingsPath, 'not json', { mode: 0o644 });
    fs.writeFileSync(credentialsPath, 'not json', { mode: 0o644 });
    const store = createRemoteAccessStore({ stateDir, onNotice: notice });
    expect(store.settings()).toEqual(DEFAULT_REMOTE_SETTINGS);
    expect(store.credentials()).toEqual([]);
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('are not valid JSON'));
    fs.writeFileSync(credentialsPath, '{}');
    expect(createRemoteAccessStore({ stateDir }).credentials()).toEqual([]);
  });

  it('keeps in-memory values when a write fails and reports the failure', () => {
    const parent = directory();
    const stateDir = path.join(parent, 'blocked');
    fs.writeFileSync(stateDir, 'not a directory');
    const notice = vi.fn();
    const store = createRemoteAccessStore({ stateDir, onNotice: notice });
    store.save({ ...DEFAULT_REMOTE_SETTINGS, idleMinutes: 99 });
    store.saveCredential(credential);
    expect(store.settings().idleMinutes).toBe(99);
    expect(store.credentials()).toEqual([credential]);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
  });
});
