import type { HubSessionScope } from '@agimon-ai/doompi-web-contracts';
import { hubChannelHarness } from '@agimon-ai/doompi-web-contracts/testing';
import { describe, expect, it } from 'vitest';
import { createTasksChannel } from '../src/adapters/webTasksChannel.ts';
import { emptyDocument, type TaskDocument } from '../src/services/store/types.ts';

class FakeStore {
  snapshot: TaskDocument;
  listener: ((document: TaskDocument) => void) | undefined;
  disposed = false;

  constructor(document: TaskDocument) {
    this.snapshot = document;
  }

  read(): TaskDocument {
    return this.snapshot;
  }

  onExternalChange(listener: (document: TaskDocument) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  publish(document: TaskDocument): void {
    this.snapshot = document;
    this.listener?.(document);
  }

  dispose(): void {
    this.disposed = true;
  }
}

function document(): TaskDocument {
  return {
    ...emptyDocument(),
    rev: 4,
    tasks: [
      { id: 1, subject: 'Build it', status: 'in_progress', blockedBy: [], activeForm: 'building it' },
      { id: 2, subject: 'Done', status: 'completed', blockedBy: [1] },
      { id: 3, subject: 'Removed', status: 'deleted' },
    ],
  };
}

describe('task graph hub channel', () => {
  it('publishes a browser-safe session snapshot and follows changes', () => {
    const stores = new Map<string, FakeStore>();
    const storeFor = (scope: HubSessionScope): FakeStore => {
      const store = new FakeStore(scope.sessionId === 's1' ? document() : emptyDocument());
      stores.set(scope.sessionId, store);
      return store;
    };
    const harness = hubChannelHarness(createTasksChannel({ storeFor }), {
      sessions: [{ sessionId: 's1', cwd: '/repo' }],
    });

    expect(harness.snapshot()).toEqual({
      rev: 4,
      tasks: [
        { id: 1, subject: 'Build it', status: 'in_progress', blockedBy: [], activeForm: 'building it' },
        { id: 2, subject: 'Done', status: 'completed', blockedBy: [1] },
      ],
    });

    stores.get('s1')?.publish({ ...document(), rev: 5, tasks: [{ id: 1, subject: 'Build it', status: 'completed' }] });
    expect(harness.published.at(-1)).toMatchObject({
      type: 'task_graph',
      sessionId: 's1',
      payload: { rev: 5, tasks: [{ id: 1, subject: 'Build it', status: 'completed', blockedBy: [] }] },
    });

    harness.close();
    expect(stores.get('s1')?.disposed).toBe(true);
  });

  it('keeps an empty session off the live publication stream', () => {
    const harness = hubChannelHarness(createTasksChannel({ storeFor: () => new FakeStore(emptyDocument()) }), {
      sessions: [{ sessionId: 'empty', cwd: '/repo' }],
    });
    expect(harness.snapshot()).toEqual({ tasks: [], rev: 0 });
    expect(harness.published).toEqual([]);
    harness.close();
  });
});
