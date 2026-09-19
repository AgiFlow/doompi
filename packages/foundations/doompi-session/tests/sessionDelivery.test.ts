import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { DoomSessionCommunicationEndpoint } from '@agimon-ai/doompi-core/hub-channel';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionDeliveryService,
  provideSessionDeliveryService,
  readDoomSessionDelivery,
  type DoomSessionDeliveryService,
} from '../src/services/sessionDelivery';

interface TestCommunications {
  readonly published: unknown[];
  bind(sessionId: string): DoomSessionCommunicationEndpoint;
}

function createDirectEvents(): TestCommunications {
  const records = new Map<
    string,
    {
      listeners: Map<string, Set<(sourceSessionId: string, payload: unknown) => void>>;
      readyListeners: Set<(peerSessionId: string) => void>;
      ready: boolean;
    }
  >();
  const published: unknown[] = [];
  return {
    published,
    bind(sessionId) {
      const listeners = new Map<string, Set<(sourceSessionId: string, payload: unknown) => void>>();
      const readyListeners = new Set<(peerSessionId: string) => void>();
      const record = { listeners, readyListeners, ready: false };
      records.set(sessionId, record);
      return {
        sessionId,
        publish(targetSessionId, type, payload) {
          published.push(payload);
          const target = records.get(targetSessionId);
          if (target?.ready !== true) return false;
          for (const listener of target.listeners.get(type) ?? []) listener(sessionId, payload);
          return true;
        },
        subscribe(type, listener) {
          const current = listeners.get(type) ?? new Set();
          current.add(listener);
          listeners.set(type, current);
          return () => current.delete(listener);
        },
        onPeerReady(listener) {
          readyListeners.add(listener);
          if (!record.ready) {
            record.ready = true;
            for (const peer of records.values()) {
              if (peer.ready) for (const peerListener of peer.readyListeners) peerListener(sessionId);
            }
          }
          for (const [peerSessionId, peer] of records)
            if (peer.ready && peerSessionId !== sessionId) listener(peerSessionId);
          return () => readyListeners.delete(listener);
        },
        close() {
          records.delete(sessionId);
        },
      };
    },
  };
}

const temporaryDirectories: string[] = [];
const services: DoomSessionDeliveryService[] = [];
const contexts: Context[] = [];

function temporaryDatabase(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-delivery-'));
  temporaryDirectories.push(directory);
  return path.join(directory, `${name}.sqlite`);
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('session delivery', () => {
  it('persists, admits, acknowledges, and supports metadata inbox consumption', async () => {
    const directEvents = createDirectEvents();
    const admit = vi.fn(async () => undefined);
    const sender = createSessionDeliveryService({
      databasePath: temporaryDatabase('sender'),
      recipientKey: 'parent',
      communication: directEvents.bind('parent'),
      authorizePeer: () => true,
      admitPrompt: async () => undefined,
    });
    const receiver = createSessionDeliveryService({
      databasePath: temporaryDatabase('receiver'),
      recipientKey: 'child',
      communication: directEvents.bind('child'),
      authorizePeer: () => true,
      admitPrompt: admit,
    });
    services.push(sender, receiver);

    await sender.deliver({
      deliveryId: 'delivery-1',
      recipientKey: 'child',
      kind: 'spawn-task',
      prompt: 'Implement the task',
      metadata: { worktreeId: 'tree-1', fromRole: 'parent' },
    });

    await vi.waitFor(() => expect(sender.outbox('delivery-1')?.recipientState).toBe('admitted'));
    expect(admit).toHaveBeenCalledOnce();
    expect(receiver.inbox({ kind: 'spawn-task', metadata: { worktreeId: 'tree-1' }, consumed: false })).toEqual([
      expect.objectContaining({
        deliveryId: 'delivery-1',
        senderKey: 'parent',
        state: 'admitted',
        metadata: { worktreeId: 'tree-1', fromRole: 'parent' },
      }),
    ]);
    expect(receiver.consume('delivery-1')).toBe(true);
    expect(receiver.consume('delivery-1')).toBe(false);
    expect(receiver.inbox({ consumed: true })).toHaveLength(1);
  });

  it('rejects unauthorized recipients and ignores unauthorized senders', async () => {
    const directEvents = createDirectEvents();
    const blocked = createSessionDeliveryService({
      databasePath: temporaryDatabase('blocked'),
      recipientKey: 'parent',
      communication: directEvents.bind('parent'),
      authorizePeer: () => false,
      admitPrompt: async () => undefined,
    });
    const admit = vi.fn(async () => undefined);
    const receiver = createSessionDeliveryService({
      databasePath: temporaryDatabase('receiver'),
      recipientKey: 'child',
      communication: directEvents.bind('child'),
      authorizePeer: () => false,
      admitPrompt: admit,
    });
    const attacker = createSessionDeliveryService({
      databasePath: temporaryDatabase('attacker'),
      recipientKey: 'attacker',
      communication: directEvents.bind('attacker'),
      authorizePeer: (peer) => peer === 'child',
      admitPrompt: async () => undefined,
    });
    services.push(blocked, receiver, attacker);

    await expect(blocked.deliver({ recipientKey: 'child', kind: 'message', prompt: 'No' })).rejects.toThrow(
      /not an authorized communication peer/u,
    );
    await attacker.deliver({ recipientKey: 'child', kind: 'message', prompt: 'No' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(admit).not.toHaveBeenCalled();
    expect(receiver.inbox()).toEqual([]);
  });
  it('does not retry a queued message after its communication authority is removed', async () => {
    const directEvents = createDirectEvents();
    let allowed = true;
    const sender = createSessionDeliveryService({
      databasePath: temporaryDatabase('sender'),
      recipientKey: 'parent',
      communication: directEvents.bind('parent'),
      authorizePeer: () => allowed,
      admitPrompt: async () => undefined,
    });
    services.push(sender);
    await sender.deliver({ deliveryId: 'removed', recipientKey: 'child', kind: 'message', prompt: 'Do not replay' });
    allowed = false;

    const admit = vi.fn(async () => undefined);
    const receiver = createSessionDeliveryService({
      databasePath: temporaryDatabase('receiver'),
      recipientKey: 'child',
      communication: directEvents.bind('child'),
      authorizePeer: () => true,
      admitPrompt: admit,
    });
    services.push(receiver);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(admit).not.toHaveBeenCalled();
    expect(receiver.inbox()).toEqual([]);
    expect(sender.outbox('removed')?.state).toBe('queued');
  });

  it('replays every queued envelope when a recipient announces readiness', async () => {
    const directEvents = createDirectEvents();
    const sender = createSessionDeliveryService({
      databasePath: temporaryDatabase('sender'),
      recipientKey: 'parent',
      communication: directEvents.bind('parent'),
      authorizePeer: () => true,
      admitPrompt: async () => undefined,
    });
    services.push(sender);
    await sender.deliver({ deliveryId: 'one', recipientKey: 'child', kind: 'message', prompt: 'One' });
    await sender.deliver({ deliveryId: 'two', recipientKey: 'child', kind: 'message', prompt: 'Two' });

    const admit = vi.fn(async () => undefined);
    const receiver = createSessionDeliveryService({
      databasePath: temporaryDatabase('receiver'),
      recipientKey: 'child',
      communication: directEvents.bind('child'),
      authorizePeer: () => true,
      admitPrompt: admit,
    });
    services.push(receiver);

    await vi.waitFor(() => expect(receiver.inbox({ state: 'admitted' })).toHaveLength(2));
    expect(admit).toHaveBeenCalledTimes(2);
    expect(sender.outbox('one')?.recipientState).toBe('admitted');
    expect(sender.outbox('two')?.recipientState).toBe('admitted');
  });
  it('does not admit a duplicate delivery id twice and acknowledges its current state', async () => {
    const directEvents = createDirectEvents();
    const admit = vi.fn(async () => undefined);
    const sender = createSessionDeliveryService({
      databasePath: temporaryDatabase('sender'),
      recipientKey: 'parent',
      communication: directEvents.bind('parent'),
      authorizePeer: () => true,
      admitPrompt: async () => undefined,
    });
    const receiver = createSessionDeliveryService({
      databasePath: temporaryDatabase('receiver'),
      recipientKey: 'child',
      communication: directEvents.bind('child'),
      authorizePeer: () => true,
      admitPrompt: admit,
    });
    const conflictingSender = createSessionDeliveryService({
      databasePath: temporaryDatabase('conflicting-sender'),
      recipientKey: 'other-parent',
      communication: directEvents.bind('other-parent'),
      authorizePeer: () => true,
      admitPrompt: async () => undefined,
    });
    services.push(sender, receiver, conflictingSender);

    const request = { deliveryId: 'same-id', recipientKey: 'child', kind: 'message', prompt: 'Hello' } as const;
    await sender.deliver(request);
    await vi.waitFor(() => expect(sender.outbox('same-id')?.recipientState).toBe('admitted'));
    await sender.deliver(request);
    await expect(sender.deliver({ ...request, prompt: 'Changed' })).rejects.toThrow(/another envelope/u);
    await conflictingSender.deliver({ ...request, prompt: 'Changed' });
    await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(1));
    expect(conflictingSender.outbox('same-id')?.state).toBe('queued');

    expect(receiver.inbox()).toHaveLength(1);
    expect(sender.outbox('same-id')).toEqual({
      deliveryId: 'same-id',
      recipientKey: 'child',
      kind: 'message',
      metadata: {},
      state: 'acknowledged',
      recipientState: 'admitted',
    });
  });

  it('marks an interrupted admission recovery_required and never replays it after restart', async () => {
    const databasePath = temporaryDatabase('receiver');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE session_delivery_inbox (
        delivery_id TEXT PRIMARY KEY, sender_key TEXT NOT NULL, recipient_key TEXT NOT NULL,
        kind TEXT NOT NULL, prompt TEXT NOT NULL, delivery_mode TEXT NOT NULL, metadata_json TEXT NOT NULL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, consumed_at INTEGER
      );
      INSERT INTO session_delivery_inbox VALUES
        ('interrupted', 'parent', 'child', 'report', 'Done', 'prompt', '{}', 'admitting', 1, 1, NULL),
        ('accepted', 'parent', 'child', 'message', 'Continue', 'prompt', '{}', 'accepted', 2, 2, NULL);
    `);
    database.close();
    const admit = vi.fn(async () => undefined);
    const directEvents = createDirectEvents();
    const receiver = createSessionDeliveryService({
      databasePath,
      recipientKey: 'child',
      communication: directEvents.bind('child'),
      authorizePeer: () => true,
      admitPrompt: admit,
    });
    services.push(receiver);

    await vi.waitFor(() => expect(receiver.inbox({ state: 'admitted' })).toHaveLength(1));
    expect(admit).toHaveBeenCalledExactlyOnceWith('Continue', 'prompt');
    expect(receiver.inbox({ state: 'recovery_required' })).toEqual([
      expect.objectContaining({ deliveryId: 'interrupted', prompt: 'Done' }),
    ]);
    expect(receiver.consume('interrupted')).toBe(true);
    expect(directEvents.published).toContainEqual(
      expect.objectContaining({ deliveryId: 'interrupted', state: 'recovery_required' }),
    );
  });

  it('provides a dynamically readable Cordis service', async () => {
    const context = new Context();
    contexts.push(context);
    const dispose = provideSessionDeliveryService(context, {
      databasePath: temporaryDatabase('provider'),
      recipientKey: 'session',
      communication: createDirectEvents().bind('session'),
      authorizePeer: () => true,
      admitPrompt: async () => undefined,
    });

    expect(readDoomSessionDelivery(context)?.recipientKey).toBe('session');
    await dispose();
    expect(readDoomSessionDelivery(context)).toBeUndefined();
  });
});
