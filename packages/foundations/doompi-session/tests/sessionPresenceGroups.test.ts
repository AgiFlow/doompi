import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionDirectory, type SessionPresenceObservation } from '../src/services/sessionDirectory';
import { createSessionGroupStore, SessionGroupRevisionError } from '../src/services/sessionGroups';

const directories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-session-groups-'));
  directories.push(directory);
  return path.join(directory, 'groups.sqlite');
}

function presence(sequence = 1): SessionPresenceObservation {
  return {
    hostId: 'host-b',
    sessionId: 'session-1',
    hostIncarnation: 'boot-1',
    sessionIncarnation: 'runtime-1',
    sequence,
    observedAt: 1_000,
    staleAfterMs: 100,
    label: 'private-label',
    deliveryTarget: 'peer/host-b/session-1',
    reachability: 'reachable',
    runtime: 'ready',
    activity: 'fully_idle',
    voice: { eligible: true, readiness: 'not_ready' },
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('truthful Session discovery', () => {
  it('filters every read, exposes qualified references and independent fresh facts, then expires facts to unknown', () => {
    let now = 1_050;
    let permitted = true;
    const directory = createSessionDirectory({
      now: () => now,
      authorizeDiscovery: () => (permitted ? { label: 'Approved peer', capabilities: ['message'] } : undefined),
    });
    expect(directory.observe(presence())).toBe(true);

    expect(directory.discover('peer/host-a/caller')).toEqual([
      expect.objectContaining({
        reference: 'peer/host-b/session-1',
        label: 'Approved peer',
        capabilities: ['message'],
        fresh: true,
        reachability: 'reachable',
        runtime: 'ready',
        activity: 'fully_idle',
        voice: { eligible: true, readiness: 'not_ready' },
        hostIncarnation: 'boot-1',
        sessionIncarnation: 'runtime-1',
        sequence: 1,
      }),
    ]);
    permitted = false;
    expect(directory.discover('peer/host-a/caller')).toEqual([]);
    permitted = true;
    now = 1_101;
    expect(directory.discover('peer/host-a/caller')[0]).toMatchObject({
      fresh: false,
      reachability: 'unknown',
      runtime: 'unknown',
      activity: 'unknown',
      voice: { eligible: 'unknown', readiness: 'unknown' },
    });
  });

  it('requires a replacement snapshot after a sequence gap and does not persist trusted observations', () => {
    const directory = createSessionDirectory({ authorizeDiscovery: () => ({ capabilities: [] }) });
    expect(directory.observe(presence())).toBe(true);
    expect(directory.observe(presence(3))).toBe(false);
    expect(directory.observe(presence(2))).toBe(false);
    expect(directory.discover('peer/host-a/caller')[0]).toMatchObject({ runtime: 'unknown' });

    directory.replaceHostSnapshot('host-b', 'boot-1', [presence(3)]);
    expect(directory.discover('peer/host-a/caller')[0]).toMatchObject({ sequence: 3 });
    expect(createSessionDirectory({ authorizeDiscovery: () => ({ capabilities: [] }) }).discover('caller')).toEqual([]);
  });

  it('rechecks subscription visibility instead of leaking a cached result after revocation', () => {
    let permitted = true;
    const directory = createSessionDirectory({
      authorizeDiscovery: () => (permitted ? { capabilities: ['message'] } : undefined),
    });
    const listener = vi.fn();
    directory.subscribe('peer/host-a/caller', listener);
    directory.observe(presence());
    permitted = false;
    directory.hostDisconnected('host-b');
    expect(listener).toHaveBeenLastCalledWith([]);
  });
});

describe('Session communication groups', () => {
  it('persists explicit membership and rejects stale or unauthorized mutation', () => {
    const file = databasePath();
    let store = createSessionGroupStore({ databasePath: file });
    const created = store.create('group-1', 'operator', ['peer/host-a/session-1', 'peer/host-b/session-1']);
    expect(created).toMatchObject({ revision: 1, ownerAuthority: 'operator' });
    expect(store.canMessage('group-1', 'peer/host-a/session-1', 'peer/host-b/session-1')).toBe(true);
    expect(() => store.mutate({ groupId: 'group-1', authority: 'other', expectedRevision: 1, remove: [] })).toThrow(
      /cannot manage/u,
    );
    store.mutate({
      groupId: 'group-1',
      authority: 'operator',
      expectedRevision: 1,
      add: ['peer/host-c/session-1'],
    });
    expect(() => store.mutate({ groupId: 'group-1', authority: 'operator', expectedRevision: 1, remove: [] })).toThrow(
      SessionGroupRevisionError,
    );
    store.close();

    store = createSessionGroupStore({ databasePath: file });
    expect(store.get('group-1')).toMatchObject({
      revision: 2,
      members: ['peer/host-a/session-1', 'peer/host-b/session-1', 'peer/host-c/session-1'],
    });
    store.close();
  });

  it('removes communication authority immediately without granting unrelated capabilities', () => {
    const store = createSessionGroupStore({ databasePath: databasePath() });
    store.create('group-1', 'operator', ['peer/host-a/session-1', 'peer/host-b/session-1']);
    const updated = store.mutate({
      groupId: 'group-1',
      authority: 'operator',
      expectedRevision: 1,
      remove: ['peer/host-b/session-1'],
    });
    expect(updated).toMatchObject({ revision: 2, members: ['peer/host-a/session-1'] });
    expect(store.canMessage('group-1', 'peer/host-a/session-1', 'peer/host-b/session-1')).toBe(false);
    expect(updated).not.toHaveProperty('controls');
    expect(updated).not.toHaveProperty('voice');
    store.close();
  });
});
