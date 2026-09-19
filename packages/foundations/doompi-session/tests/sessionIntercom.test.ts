import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DoomSessionDeliveryService } from '../src/services/sessionDelivery';
import { createSessionDirectory } from '../src/services/sessionDirectory';
import { createSessionGroupStore } from '../src/services/sessionGroups';
import { createSessionGroupDeliveryAuthorizer, createSessionIntercom } from '../src/services/sessionIntercom';

const directories: string[] = [];
const SELF = 'peer/host-a/session-a';
const TARGET = 'peer/host-b/session-b';

function groupStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-intercom-'));
  directories.push(directory);
  const store = createSessionGroupStore({ databasePath: path.join(directory, 'groups.sqlite') });
  store.create('friends', 'operator', [SELF, TARGET]);
  return store;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Session intercom surface', () => {
  it('discovers group members and sends attributed messages and correlated reports through Session delivery', async () => {
    const groups = groupStore();
    const directory = createSessionDirectory({ authorizeDiscovery: () => ({ capabilities: ['message'] }) });
    directory.observe({
      hostId: 'host-b',
      sessionId: 'session-b',
      hostIncarnation: 'boot-b',
      sessionIncarnation: 'runtime-b',
      sequence: 1,
      observedAt: Date.now(),
      staleAfterMs: 1_000,
      deliveryTarget: 'transport-target',
      reachability: 'reachable',
      runtime: 'ready',
      activity: 'busy',
      voice: { eligible: false, readiness: 'not_ready' },
    });
    const deliver = vi.fn(async (request) => ({ deliveryId: request.deliveryId ?? 'generated' }));
    const delivery = {
      recipientKey: 'self',
      deliver,
      waitForAdmission: vi.fn(),
      inbox: vi.fn(() => []),
      receive: vi.fn(),
      consume: vi.fn(),
      outbox: vi.fn(),
      close: vi.fn(),
    } satisfies DoomSessionDeliveryService;
    const intercom = createSessionIntercom({ selfReference: SELF, directory, groups, delivery });

    expect(intercom.discover()).toEqual([
      expect.objectContaining({ reference: TARGET, capabilities: ['message'], runtime: 'ready' }),
    ]);
    await intercom.send({ targetReference: TARGET, groupId: 'friends', text: 'Hello', correlationId: 'task-1' });
    await intercom.report({
      targetReference: TARGET,
      groupId: 'friends',
      text: 'Finished',
      correlationId: 'task-1',
      status: 'done',
    });
    expect(deliver).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        recipientKey: 'transport-target',
        kind: 'session-message',
        prompt: `[Session message from ${SELF}] Hello`,
        metadata: expect.objectContaining({ sourceReference: SELF, targetReference: TARGET, groupId: 'friends' }),
      }),
    );
    expect(deliver).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: 'session-report', metadata: expect.objectContaining({ reportStatus: 'done' }) }),
    );
    groups.close();
  });

  it('keeps revoked delivery evidence durable but hides it from the removed caller', () => {
    const groups = groupStore();
    const directory = createSessionDirectory({ authorizeDiscovery: () => ({ capabilities: ['message'] }) });
    const evidence = {
      deliveryId: 'delivery-1',
      senderKey: 'transport-target',
      recipientKey: 'self',
      kind: 'session-message',
      prompt: 'Historical message',
      delivery: 'prompt' as const,
      metadata: { sourceReference: TARGET, targetReference: SELF, groupId: 'friends' },
      state: 'admitted' as const,
      consumed: false,
    };
    const delivery = {
      recipientKey: 'self',
      deliver: vi.fn(),
      waitForAdmission: vi.fn(),
      inbox: vi.fn(() => [evidence]),
      receive: vi.fn(),
      consume: vi.fn(),
      outbox: vi.fn(() => ({
        deliveryId: 'delivery-1',
        recipientKey: 'transport-target',
        kind: 'session-message',
        metadata: evidence.metadata,
        state: 'acknowledged' as const,
      })),
      close: vi.fn(),
    } satisfies DoomSessionDeliveryService;
    const intercom = createSessionIntercom({ selfReference: SELF, directory, groups, delivery });
    expect(intercom.messages()).toHaveLength(1);
    expect(intercom.delivery('delivery-1')).toBeDefined();

    groups.mutate({ groupId: 'friends', authority: 'operator', expectedRevision: 1, remove: [SELF] });
    expect(delivery.inbox()).toEqual([evidence]);
    expect(intercom.messages()).toEqual([]);
    expect(intercom.delivery('delivery-1')).toBeUndefined();
    groups.close();
  });

  it('revalidates authoritative membership and blocks messaging after removal', () => {
    const groups = groupStore();
    const authorize = createSessionGroupDeliveryAuthorizer({
      selfReference: SELF,
      groups,
      peerReference: (key) => (key === 'transport-target' ? TARGET : undefined),
    });
    const metadata = { sourceReference: SELF, targetReference: TARGET, groupId: 'friends' };
    expect(authorize('transport-target', metadata)).toBe(true);
    groups.mutate({
      groupId: 'friends',
      authority: 'operator',
      expectedRevision: 1,
      remove: [TARGET],
    });
    expect(authorize('transport-target', metadata)).toBe(false);
    groups.close();
  });
});
