import type { DoomHubChannelHost, DoomHubSessionScope } from '@agimon-ai/doompi-core/hub-channel';
import { describe, expect, it } from 'vitest';
import { createTasksChannel } from '../src/controllers/webTasksChannel';
import { emptyDocument, type TaskDocument } from '../src/models/task';
import { TASKS_CHANNEL_TYPE } from '../src/types/webTasks';

class FakeStore {
  snapshot: TaskDocument;
  disposed = false;

  constructor(document: TaskDocument) {
    this.snapshot = document;
  }

  read(): TaskDocument {
    return this.snapshot;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function directEvents() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const key = (frameType: string, sessionId: string): string => `${frameType}:${sessionId}`;
  return {
    publish(frameType: string, sessionId: string, payload: unknown): void {
      for (const listener of listeners.get(key(frameType, sessionId)) ?? []) listener(payload);
    },
    subscribe(frameType: string, sessionId: string, listener: (payload: unknown) => void): () => void {
      const listenersForKey = listeners.get(key(frameType, sessionId)) ?? new Set<(payload: unknown) => void>();
      listenersForKey.add(listener);
      listeners.set(key(frameType, sessionId), listenersForKey);
      return () => listenersForKey.delete(listener);
    },
    close(): void {
      listeners.clear();
    },
  };
}

function createHost(scopes: readonly DoomHubSessionScope[]) {
  const published: Array<{ sessionId: string; payload: unknown }> = [];
  const events = directEvents();
  const value: DoomHubChannelHost = {
    sessions: () => scopes,
    directEvents: events,
    publish: (sessionId, payload) => published.push({ sessionId, payload }),
    requestSessionApi: () => Promise.resolve(Response.json({ error: 'not implemented' }, { status: 501 })),
    onNotice: () => undefined,
  };
  return { host: value, events, published };
}

function document(rev: number, subject: string): TaskDocument {
  return {
    ...emptyDocument(),
    rev,
    tasks: [{ id: 1, subject, status: 'in_progress', blockedBy: [] }],
  };
}

describe('task graph hub channel', () => {
  it('seeds durable state and follows direct commits for two isolated sessions', () => {
    const scopes: DoomHubSessionScope[] = [
      { sessionId: 's1', cwd: '/repo-1' },
      { sessionId: 's2', cwd: '/repo-2' },
    ];
    const stores = new Map([
      ['s1', new FakeStore(document(4, 'first'))],
      ['s2', new FakeStore(document(7, 'second'))],
    ]);
    const channel = createTasksChannel({ storeFor: (scope) => stores.get(scope.sessionId)! });
    const { host, events, published } = createHost(scopes);
    const source = channel.start(host);

    expect(source.payloadFor(scopes[0]!)).toEqual({
      rev: 4,
      tasks: [{ id: 1, subject: 'first', status: 'in_progress', blockedBy: [] }],
    });
    expect(source.payloadFor(scopes[1]!)).toEqual({
      rev: 7,
      tasks: [{ id: 1, subject: 'second', status: 'in_progress', blockedBy: [] }],
    });

    const firstUpdate = document(5, 'first updated');
    events.publish(TASKS_CHANNEL_TYPE, 's1', firstUpdate);
    expect(published.at(-1)).toEqual({
      sessionId: 's1',
      payload: { rev: 5, tasks: [{ id: 1, subject: 'first updated', status: 'in_progress', blockedBy: [] }] },
    });
    expect(source.payloadFor(scopes[1]!)).toMatchObject({ rev: 7 });

    const secondUpdate = document(8, 'second updated');
    events.publish(TASKS_CHANNEL_TYPE, 's2', secondUpdate);
    expect(published.at(-1)).toEqual({
      sessionId: 's2',
      payload: { rev: 8, tasks: [{ id: 1, subject: 'second updated', status: 'in_progress', blockedBy: [] }] },
    });

    const count = published.length;
    events.publish(TASKS_CHANNEL_TYPE, 's1', { rev: 'invalid', tasks: [] });
    expect(published).toHaveLength(count);

    source.sessionRemoved?.('s1');
    events.publish(TASKS_CHANNEL_TYPE, 's1', document(6, 'ignored'));
    expect(published).toHaveLength(count);
    expect(stores.get('s1')?.disposed).toBe(true);

    source.close();
    expect(stores.get('s2')?.disposed).toBe(true);
  });

  it('keeps an empty durable session off the live publication stream', () => {
    const scope: DoomHubSessionScope = { sessionId: 'empty', cwd: '/repo' };
    const store = new FakeStore(emptyDocument());
    const { host, published } = createHost([scope]);
    const source = createTasksChannel({ storeFor: () => store }).start(host);

    expect(source.payloadFor(scope)).toEqual({ tasks: [], rev: 0 });
    expect(published).toEqual([]);
    source.close();
    expect(store.disposed).toBe(true);
  });
});
