import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { MemorySessionRepo, setValue, value } from '@earendil-works/pi-agent-core/harness/session';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';

import { createDirectHarnessRuntime } from '../../../../../src/server/directHarnessRuntime';
import { createHistoryOwnership } from '../../../../../src/services/historyOwnership';

const model: Model<Api> = {
  id: 'lifecycle-model',
  name: 'Lifecycle model',
  api: 'test-api',
  provider: 'test-provider',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65_536,
  maxTokens: 256,
};

function message(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: 'stop',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function fixtures() {
  const repository = new MemorySessionRepo();
  const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
  const streamSimple = vi.fn<Models['streamSimple']>(() => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message('pending') });
    streams.push(stream);
    return stream;
  });
  const models = {
    getModels: () => [model],
    getModel: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
    getAvailable: async () => [model],
    streamSimple,
  } as unknown as Models;
  return { repository, streams, models, streamSimple };
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  await vi.waitFor(async () => expect(await condition()).toBe(true));
}

describe('direct harness durable lifecycle', () => {
  it('pauses queued work on abort until explicit resume and then dispatches it once', async () => {
    const { repository, models, streams, streamSimple } = fixtures();
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      const active = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const queued = await runtime.enqueueAutomatic('second');
      expect((await runtime.readLifecycle()).queue).toEqual([
        expect.objectContaining({ id: queued.id, text: 'second', disposition: 'pending' }),
      ]);
      const activeId = (await runtime.readLifecycle()).operation?.id;
      expect(activeId).toBeTruthy();
      await runtime.abort(activeId);
      expect((await runtime.readLifecycle()).paused).toBe(true);
      const first = streams[0]!;
      first.push({ type: 'done', reason: 'stop', message: message('late output') });
      await active.settled.catch(() => undefined);
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(streamSimple).toHaveBeenCalledTimes(1);
      expect((await runtime.readLifecycle()).queue).toEqual([
        expect.objectContaining({ id: queued.id, disposition: 'pending' }),
      ]);
      await runtime.resumeQueue();
      await waitFor(() => streams.length === 2);
      const replacement = (await runtime.readLifecycle()).operation;
      expect(replacement?.id).not.toBe(activeId);
      await runtime.abort(activeId);
      expect((await runtime.readLifecycle()).operation?.id).toBe(replacement?.id);
      expect((await runtime.readLifecycle()).paused).toBe(false);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect((await runtime.readLifecycle()).queue).toEqual([]);
      expect(streamSimple).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('preserves identical acknowledged steers as distinct queued inputs after abort', async () => {
    const { repository, models, streams } = fixtures();
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      const active = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      await runtime.steer('same');
      await runtime.steer('same');
      const initial = (await runtime.readLifecycle()).queue;
      expect(initial.map((item) => item.text)).toEqual(['same', 'same']);
      expect(new Set(initial.map((item) => item.id)).size).toBe(2);
      await runtime.abort((await runtime.readLifecycle()).operation?.id);
      const after = await runtime.readLifecycle();
      expect(after.paused).toBe(true);
      expect(after.queue.map((item) => item.id)).toEqual(initial.map((item) => item.id));
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('late') });
      await active.settled.catch(() => undefined);
      expect((await runtime.readLifecycle()).queue.map((item) => item.text)).toEqual(['same', 'same']);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('keeps a held extension follow-up dormant until a later explicit turn', async () => {
    const { repository, models, streams } = fixtures();
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      const active = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      await runtime.followUp('voice');
      expect((await runtime.readLifecycle()).queue).toMatchObject([{ text: 'voice', scheduling: 'held' }]);
      await runtime.abort((await runtime.readLifecycle()).operation?.id);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('late') });
      await active.settled.catch(() => undefined);
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect((await runtime.readLifecycle()).queue).toMatchObject([{ text: 'voice', scheduling: 'held' }]);
      await runtime.resumeQueue();
      expect(streams).toHaveLength(1);
      const explicit = await runtime.submitPrompt('explicit turn');
      await waitFor(() => streams.length === 2);
      await waitFor(async () => JSON.stringify((await runtime.readEntries()).entries).includes('voice'));
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('done') });
      await explicit.settled.catch(() => undefined);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('keeps an ambiguous native abort return visible instead of dropping an unmatched steer', async () => {
    const { repository, models, streams } = fixtures();
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      const active = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      await runtime.steer('first');
      await runtime.steer('second');
      const requestAbort = runtime.lane.requestAbort.bind(runtime.lane);
      vi.spyOn(runtime.lane, 'requestAbort').mockImplementation(async (...args) => {
        const result = await requestAbort(...args);
        return result.ok ? { ...result, value: { ...result.value, steer: result.value.steer.slice(1) } } : result;
      });
      await runtime.abort((await runtime.readLifecycle()).operation?.id);
      const queue = (await runtime.readLifecycle()).queue;
      expect(queue.filter((item) => item.disposition === 'uncertain')).toHaveLength(2);
      expect(queue.filter((item) => item.disposition === 'pending')).toMatchObject([
        { text: 'second', scheduling: 'held' },
      ]);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('late') });
      await active.settled.catch(() => undefined);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('retains a paused queue across an actual SQLite close and reopen', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-lifecycle-'));
    const { models, streams, streamSimple } = fixtures();
    const open = () =>
      createDirectHarnessRuntime({
        cwd: root,
        sessionsRoot: root,
        sessionId: 'lifecycle_restart',
        storage: 'sqlite' as const,
        historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
        models,
        model,
      });
    let runtime = await open();
    try {
      const active = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const pending = await runtime.enqueueAutomatic('after restart');
      await runtime.abort((await runtime.readLifecycle()).operation?.id);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('late') });
      await active.settled.catch(() => undefined);
      await runtime.dispose();
      runtime = await open();
      await runtime.recover();
      const recovered = await runtime.readLifecycle();
      expect(recovered.paused).toBe(true);
      expect(recovered.queue).toEqual([expect.objectContaining({ id: pending.id, text: 'after restart' })]);
      expect(streamSimple).toHaveBeenCalledTimes(1);
      await runtime.resumeQueue();
      await waitFor(() => streams.length === 2);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('resumed') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(streamSimple).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes one pending item without replaying its neighbors and promotes by stable identity', async () => {
    const { repository, models, streams } = fixtures();
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      const active = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const first = await runtime.enqueueAutomatic('first');
      const middle = await runtime.enqueueAutomatic('middle');
      const last = await runtime.enqueueAutomatic('last');
      expect(await runtime.removeQueued(middle.id)).toBe('removed');
      const id = (await runtime.readLifecycle()).operation?.id;
      expect(id).toBeTruthy();
      expect(await runtime.promoteQueued(first.id, id!)).toBe('promoted');
      await waitFor(async () =>
        (await runtime.readLifecycle()).queue.some((item) => item.id === first.id && item.delivery === 'steer'),
      );
      expect((await runtime.readLifecycle()).queue.map((item) => item.id)).toEqual([first.id, last.id]);
      await runtime.abort(id);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('late') });
      await active.settled.catch(() => undefined);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('starts persisted idle automatic work when reopening the session', async () => {
    const { repository, models, streams } = fixtures();
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    await session.mutate(async (mutator) => {
      await mutator.commit(
        [
          setValue(value('doompi.server.lifecycle', 'main'), {
            version: 1,
            revision: 1,
            paused: false,
            queue: [
              { id: 'recovered', text: 'next', delivery: 'followUp', scheduling: 'automatic', disposition: 'pending' },
            ],
          }),
        ],
        BACKGROUND_CONTEXT,
      );
    }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      await expect(runtime.resume()).resolves.toBe(false);
      await waitFor(() => streams.length === 1);
      expect((await runtime.readLifecycle()).queue).toEqual([]);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('done') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
});
