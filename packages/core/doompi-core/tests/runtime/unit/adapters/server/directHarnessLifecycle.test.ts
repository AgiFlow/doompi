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
import { Type } from 'typebox';
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

function fixtures(abortAware = false) {
  const repository = new MemorySessionRepo();
  const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
  const streamSimple = vi.fn<Models['streamSimple']>((_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message('pending') });
    streams.push(stream);
    if (abortAware)
      options?.signal?.addEventListener(
        'abort',
        () =>
          stream.push({
            type: 'error',
            reason: 'aborted',
            error: { ...message('cancelled'), stopReason: 'aborted' },
          }),
        { once: true },
      );
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

  // A rejected settled-marker write used to poison the run_end chain, so the operation never
  // cleared and every later prompt read as "A turn is already running".
  it('settles the run and frees the lane when the settled marker cannot be written', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-settled-'));
    const { models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({
      cwd: root,
      sessionsRoot: root,
      sessionId: 'settled_marker_failure',
      storage: 'sqlite' as const,
      historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
      models,
      model,
    });
    const frames: string[] = [];
    runtime.onPresentationFrame((frame) => frames.push(String(frame.type)));
    const findEntry = vi.spyOn(runtime.lane, 'findEntry').mockRejectedValueOnce(new Error('database is locked'));
    try {
      const first = await runtime.submitPrompt('first');
      await waitFor(() => streams.length === 1);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('one') });
      await first.settled;
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(findEntry).toHaveBeenCalled();
      expect(frames).toContain('agent_settled');

      const second = await runtime.submitPrompt('second');
      await waitFor(() => streams.length === 2);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('two') });
      await second.settled;
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes one pending item and interrupts with only the selected stable identity', async () => {
    const { repository, models, streams } = fixtures(true);
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      const active = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const first = await runtime.enqueueAutomatic('same');
      const middle = await runtime.enqueueAutomatic('middle');
      const last = await runtime.enqueueAutomatic('same');
      expect(await runtime.removeQueued(middle.id)).toBe('removed');
      const id = (await runtime.readLifecycle()).operation!.id;
      expect(await runtime.promoteQueued(first.id, id)).toBe('promoted');
      await active.settled.catch(() => undefined);
      await waitFor(() => streams.length === 2);
      expect((await runtime.readLifecycle()).operation?.id).not.toBe(id);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: true, queue: [{ id: last.id, text: 'same' }] });
      expect(await runtime.removeQueued(first.id)).toBe('already_consumed');
      expect(await runtime.removeQueued(middle.id)).toBe('removed');
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      const entries = (await runtime.readEntries()).entries;
      expect(
        entries.filter(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'user' &&
            JSON.stringify(entry.message.content).includes('same'),
        ),
      ).toHaveLength(1);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('admits immediate user input while preserving paused automatic and held inputs with images', async () => {
    const { repository, models, streams } = fixtures(true);
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
    try {
      const first = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      await runtime.followUp('held', [image]);
      const automatic = await runtime.enqueueAutomatic('automatic', [image]);
      const before = (await runtime.readLifecycle()).queue;
      const replacement = await runtime.submitUserPrompt('voice now', [image]);
      await first.settled.catch(() => undefined);
      await waitFor(() => streams.length === 2);
      expect(await runtime.readLifecycle()).toMatchObject({
        paused: true,
        queue: before.map((entry) => ({ ...entry, disposition: 'pending' })),
      });
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await replacement.settled;
      const entries = (await runtime.readEntries()).entries;
      expect(
        entries.filter(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'user' &&
            JSON.stringify(entry.message.content).includes('voice now'),
        ),
      ).toHaveLength(1);
      expect(streams).toHaveLength(2);
      expect((await runtime.readLifecycle()).queue.find((entry) => entry.id === automatic.id)?.images).toEqual([image]);
      await runtime.resumeQueue();
      await waitFor(() => streams.length === 3);
      streams[2]!.push({ type: 'done', reason: 'stop', message: message('resumed') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect((await runtime.readLifecycle()).queue).toMatchObject([
        { text: 'held', scheduling: 'held', images: [image] },
      ]);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('sends one selected paused input from idle and rejects stale active targets', async () => {
    const { repository, models, streams } = fixtures(true);
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      const first = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const one = await runtime.enqueueAutomatic('one');
      const two = await runtime.enqueueAutomatic('two');
      await runtime.interrupt();
      await first.settled.catch(() => undefined);
      expect(await runtime.promoteQueued(one.id, 'stale')).toBe('target_changed');
      expect(await runtime.promoteQueued(one.id)).toBe('promoted');
      await waitFor(() => streams.length === 2);
      expect(await runtime.promoteQueued(two.id)).toBe('target_changed');
      expect(await runtime.readLifecycle()).toMatchObject({ paused: true, queue: [{ id: two.id }] });
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(streams).toHaveLength(2);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('blocks competing admissions during cancellation without holding the mutation line', async () => {
    const { repository, models, streams } = fixtures();
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      const first = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const replacement = runtime.submitUserPrompt('voice now');
      await waitFor(async () => (await runtime.readLifecycle()).operation?.status === 'aborting');
      await expect(runtime.submitPrompt('competitor')).rejects.toThrow('interruption');
      await expect(runtime.submitUserPrompt('second interruption')).rejects.toThrow('interruption');
      await expect(runtime.resumeQueue()).rejects.toThrow('interruption');
      await expect(runtime.compact()).rejects.toThrow('interruption');
      await expect(runtime.navigateTree(null)).rejects.toThrow('interruption');
      const retained = await runtime.enqueueAutomatic('retained');
      expect(await runtime.removeQueued(retained.id)).toBe('removed');
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('late') });
      await first.settled.catch(() => undefined);
      const admitted = await replacement;
      await waitFor(() => streams.length === 2);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await admitted.settled;
      expect((await runtime.readLifecycle()).queue).toEqual([]);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('reconciles a selected native acceptance with a lost acknowledgement without retrying', async () => {
    const { repository, models, streams } = fixtures(true);
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      const first = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const selected = await runtime.enqueueAutomatic('selected');
      const id = (await runtime.readLifecycle()).operation!.id;
      const accept = runtime.lane.accept.bind(runtime.lane);
      const spy = vi.spyOn(runtime.lane, 'accept').mockImplementationOnce(async (...args) => {
        await accept(...args);
        throw new Error('acknowledgement lost');
      });
      expect(await runtime.promoteQueued(selected.id, id)).toBe('promoted');
      await first.settled.catch(() => undefined);
      await waitFor(() => streams.length === 2);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await runtime.removeQueued(selected.id)).toBe('already_consumed');
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(streams).toHaveLength(2);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('waits for signal-aware tool cleanup before starting the replacement provider', async () => {
    const { repository, models, streams } = fixtures();
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    let started!: () => void;
    let cancelled!: () => void;
    let releaseCleanup!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const toolCancelled = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanedUp = false;
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models,
      model,
      tools: [
        {
          name: 'gated',
          label: 'Gated',
          description: 'Waits for cancellation',
          parameters: Type.Object({}),
          async execute(_id, _args, _update, _toolContext, _invocation, context) {
            started();
            await new Promise<void>((resolve) =>
              context.abortSignal!.addEventListener(
                'abort',
                () => {
                  cancelled();
                  resolve();
                },
                { once: true },
              ),
            );
            await cleanup;
            cleanedUp = true;
            return { content: [{ type: 'text', text: 'cleaned up' }], details: undefined };
          },
        },
      ],
    });
    try {
      const first = await runtime.submitPrompt('use tool');
      await waitFor(() => streams.length === 1);
      streams[0]!.push({
        type: 'done',
        reason: 'toolUse',
        message: {
          ...message('tool'),
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'gated-1', name: 'gated', arguments: {} }],
        },
      });
      await toolStarted;
      const replacement = runtime.submitUserPrompt('answer instead');
      await toolCancelled;
      expect(cleanedUp).toBe(false);
      expect(streams).toHaveLength(1);
      releaseCleanup();
      const admitted = await replacement;
      await first.settled.catch(() => undefined);
      await waitFor(() => streams.length === 2);
      expect(cleanedUp).toBe(true);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await admitted.settled;
    } finally {
      releaseCleanup();
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('resumes the exact accepted user replacement without unpausing retained inputs', async () => {
    const { repository, models, streams } = fixtures();
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      await session.mutate(async (mutator) => {
        await mutator.commit(
          [
            setValue(value('doompi.server.lifecycle', 'main'), {
              version: 1,
              revision: 1,
              paused: true,
              userOperationId: 'replacement',
              queue: [
                {
                  id: 'retained',
                  text: 'later',
                  delivery: 'followUp',
                  scheduling: 'automatic',
                  disposition: 'pending',
                },
              ],
            }),
          ],
          BACKGROUND_CONTEXT,
        );
      }, BACKGROUND_CONTEXT);
      const admitted = await runtime.lane.accept(
        { kind: 'prompt', operationId: 'replacement', prompt: 'voice' },
        BACKGROUND_CONTEXT,
      );
      expect(admitted.ok).toBe(true);
      const resumed = await runtime.admitResume();
      expect(resumed.resumed).toBe(true);
      await waitFor(() => streams.length === 1);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: true, queue: [{ id: 'retained' }] });
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await resumed.settled;
      expect(streams).toHaveLength(1);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('sends only the selected idle automatic input even when its neighbors were unpaused', async () => {
    const { repository, models, streams } = fixtures();
    const session = await repository.create({ id: randomUUID() }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      await session.mutate(async (mutator) => {
        await mutator.commit(
          [
            setValue(value('doompi.server.lifecycle', 'main'), {
              version: 1,
              revision: 1,
              paused: false,
              queue: ['selected', 'neighbor'].map((id) => ({
                id,
                text: id,
                delivery: 'followUp',
                scheduling: 'automatic',
                disposition: 'pending',
              })),
            }),
          ],
          BACKGROUND_CONTEXT,
        );
      }, BACKGROUND_CONTEXT);
      expect(await runtime.promoteQueued('selected')).toBe('promoted');
      await waitFor(() => streams.length === 1);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: true, queue: [{ id: 'neighbor' }] });
      expect(streams).toHaveLength(1);
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
