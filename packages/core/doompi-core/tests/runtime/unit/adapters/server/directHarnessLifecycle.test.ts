import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { CompactionTask, InboxDoc, LiveDoc, MemoryStorage, createSession, defineDoc } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import { createDirectHarnessRuntime } from '../../../../../src/server/directHarnessRuntime';
import { createHistoryOwnership } from '../../../../../src/services/historyOwnership';
import type { Entry } from '../../../../../src/types/server/directHarnessRuntime';

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

function fixtures(signalAware = false) {
  const repository = new MemoryStorage();
  const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
  const streamSimple = vi.fn<Models['streamSimple']>((_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message('pending') });
    if (signalAware)
      options?.signal?.addEventListener(
        'abort',
        () =>
          stream.push({ type: 'error', reason: 'aborted', error: { ...message('aborted'), stopReason: 'aborted' } }),
        { once: true },
      );
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
  it('publishes streaming frames in order while an extension listener is blocked', async () => {
    const { repository, models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    const frames: string[] = [];
    runtime.onPresentationFrame((frame) => frames.push(String(frame.type)));
    runtime.onEvent(async (event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant' && !blocked) {
        blocked = true;
        await gate;
      }
    });
    try {
      const first = await runtime.submitPrompt('first');
      await waitFor(() => streams.length === 1);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('one') });
      await waitFor(() => blocked);
      frames.length = 0;
      const second = await runtime.submitPrompt('second');
      await waitFor(() => streams.length === 2);
      await waitFor(
        async () =>
          !!(await runtime.harness.snapshot(LiveDoc, runtime.lane.id, BACKGROUND_CONTEXT))?.generation?.message,
      );
      streams[1]!.push({ type: 'text_delta', contentIndex: 0, delta: 'streamed', partial: message('streamed') });
      await vi.waitFor(() => expect(frames).toContain('message_update'));
      expect(frames.indexOf('message_start')).toBeGreaterThanOrEqual(0);
      expect(frames.indexOf('message_start')).toBeLessThan(frames.indexOf('message_update'));
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('complete') });
      release();
      await first.settled;
      await second.settled;
    } finally {
      release();
      await runtime.dispose();
    }
  });

  it('delivers internal results without exposing or clearing them through the operator queue', async () => {
    const { repository, models, streams, streamSimple } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    const ended: unknown[] = [];
    const customFrames: unknown[] = [];
    runtime.onPresentationFrame((frame) => {
      const entry = frame.entry as Entry | undefined;
      if (frame.type === 'entry_appended' && entry?.type === 'message' && entry.message.role === 'custom')
        customFrames.push(entry);
    });
    runtime.onEvent((event) => {
      if (event.type === 'message_end') ended.push(event.message);
    });
    try {
      const active = await runtime.submitPrompt('operator');
      await waitFor(() => streams.length === 1);
      await runtime.nextRun('operator queued');
      const internal = await runtime.submitInternalMessage({
        role: 'custom',
        customType: 'runner-result',
        content: 'runner finished',
        display: true,
        details: { runId: 'runner-one' },
        timestamp: Date.now(),
      });
      expect((await runtime.readLifecycle()).queue.map((item) => item.text)).toEqual(['operator queued']);
      await runtime.clearQueue();
      expect((await runtime.readLifecycle()).queue).toEqual([]);
      expect((await runtime.readState()).pendingMessageCount).toBe(1);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('one') });
      await waitFor(() => streams.length === 2);
      const context = JSON.stringify(streamSimple.mock.calls[1]![1]);
      expect(context.split('runner finished')).toHaveLength(2);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('two') });
      await internal.settled;
      await active.settled;
      expect(customFrames).toHaveLength(1);
      expect(ended).toContainEqual(
        expect.objectContaining({ role: 'custom', customType: 'runner-result', details: { runId: 'runner-one' } }),
      );
      expect((await runtime.readEntries()).entries).toContainEqual(
        expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({
            role: 'custom',
            customType: 'runner-result',
            content: 'runner finished',
            display: true,
            details: { runId: 'runner-one' },
          }),
        }),
      );
      expect(
        (await runtime.readEntries()).entries.some(
          (entry) =>
            entry.type === 'message' && entry.message.role === 'user' && entry.message.content === 'runner finished',
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it.each(['abort', 'failure', 'custom abort', 'custom failure'] as const)(
    'preserves unplaced internal input as passive context after %s',
    async (outcome) => {
      const { repository, models, streams, streamSimple } = fixtures(true);
      const contexts: unknown[] = [];
      const runtime = await createDirectHarnessRuntime({
        cwd: '/tmp',
        durableStorage: repository,
        models,
        model,
        transformContext: ({ messages }) => {
          contexts.push(messages);
          return { messages };
        },
      });
      try {
        const active = await runtime.submitPrompt('operator');
        void active.settled.catch(() => undefined);
        await waitFor(() => streams.length === 1);
        const internal = await runtime.submitInternalMessage(
          outcome.startsWith('custom')
            ? {
                role: 'custom',
                customType: 'result',
                content: 'durable result',
                display: true,
                details: { source: 'tool' },
                timestamp: 1,
              }
            : 'durable result',
          'followUp',
        );
        if (outcome.endsWith('abort')) await runtime.abort();
        else
          streams[0]!.push({
            type: 'error',
            reason: 'error',
            error: { ...message('failed'), stopReason: 'error', errorMessage: 'provider failed' },
          });
        await expect(internal.settled).resolves.toBeUndefined();
        expect(streams).toHaveLength(1);
        expect(JSON.stringify(await runtime.lane.context(BACKGROUND_CONTEXT))).toContain('durable result');
        if (outcome.startsWith('custom')) {
          const custom = (await runtime.readEntries()).entries.filter(
            (entry) =>
              entry.type === 'message' && entry.message.role === 'custom' && entry.message.customType === 'result',
          );
          expect(custom).toHaveLength(1);
        }
        const next = await runtime.submitPrompt('ordinary prompt');
        await waitFor(() => streams.length === 2);
        expect(JSON.stringify(streamSimple.mock.calls[1]![1]).split('durable result')).toHaveLength(2);
        if (outcome.startsWith('custom'))
          expect(contexts.at(-1)).toContainEqual(
            expect.objectContaining({
              role: 'custom',
              customType: 'result',
              display: true,
              details: { source: 'tool' },
            }),
          );
        streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
        await next.settled;
      } finally {
        await runtime.dispose();
      }
    },
  );

  it('defers internal admission during interruption without blocking the end hook', async () => {
    const { repository, models, streams, streamSimple } = fixtures(true);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let internal: { settled: Promise<void> } | undefined;
    runtime.onEvent(async (event) => {
      if (event.type === 'run_end' && !internal) {
        internal = await runtime.submitInternalMessage('environmental during interruption');
        await gate;
      }
    });
    try {
      const first = await runtime.submitPrompt('first');
      await waitFor(() => streams.length === 1);
      const admitting = runtime.submitUserPrompt('fresh operator');
      await waitFor(() => !!internal);
      expect(streams).toHaveLength(1);
      expect((await runtime.readState()).pendingMessageCount).toBe(1);
      const Lifecycle = defineDoc({
        kind: 'doompi.server.lifecycle',
        version: 1,
        scope: 'session',
        initial: () => ({ json: '' }),
      });
      const persisted = JSON.parse((await runtime.harness.snapshot(Lifecycle, BACKGROUND_CONTEXT))!.json);
      expect(Object.values(persisted.internalDeliveries ?? {})).toContainEqual(
        expect.objectContaining({ message: expect.objectContaining({ content: 'environmental during interruption' }) }),
      );
      release();
      const replacement = await admitting;
      await waitFor(() => streams.length === 2);
      expect(JSON.stringify(streamSimple.mock.calls[1]![1])).not.toContain('environmental during interruption');
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('operator answer') });
      await waitFor(() => streams.length === 3);
      expect(JSON.stringify(streamSimple.mock.calls[2]![1])).toContain('environmental during interruption');
      streams[2]!.push({ type: 'done', reason: 'stop', message: message('environmental answer') });
      await internal!.settled;
      await replacement.settled;
      await first.settled;
    } finally {
      release();
      await runtime.dispose();
    }
  });

  it('holds nextTurn through internal and automatic runs until an ordinary user prompt', async () => {
    const { repository, models, streams, streamSimple } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    try {
      await (
        await runtime.submitInternalMessage(
          { role: 'custom', customType: 'deferred', content: 'next user context', display: true, timestamp: 1 },
          'nextTurn',
        )
      ).settled;
      expect(streams).toHaveLength(0);
      expect(JSON.stringify((await runtime.readEntries()).entries)).not.toContain('next user context');
      expect((await runtime.readState()).pendingMessageCount).toBe(1);
      const internal = await runtime.submitInternalMessage('environmental input');
      await waitFor(() => streams.length === 1);
      expect(JSON.stringify(streamSimple.mock.calls[0]![1])).not.toContain('next user context');
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('internal done') });
      await internal.settled;
      await runtime.nextRun('automatic input');
      await waitFor(() => streams.length === 2);
      expect(JSON.stringify(streamSimple.mock.calls[1]![1])).not.toContain('next user context');
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('automatic done') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      const ordinary = await runtime.submitPrompt('ordinary user');
      await waitFor(() => streams.length === 3);
      expect(JSON.stringify(streamSimple.mock.calls[2]![1]).split('next user context')).toHaveLength(2);
      expect((await runtime.readState()).pendingMessageCount).toBe(0);
      streams[2]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await ordinary.settled;
    } finally {
      await runtime.dispose();
    }
  });

  it('internal continuations wake an idle agent without releasing paused operator inputs', async () => {
    const { repository, models, streams } = fixtures(true);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    try {
      const active = await runtime.submitPrompt('operator');
      await waitFor(() => streams.length === 1);
      await runtime.enqueueAutomatic('operator queued');
      await runtime.abort();
      await active.settled;
      const internal = await runtime.submitInternalMessage('goal continue');
      await waitFor(() => streams.length === 2);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: true, queue: [{ text: 'operator queued' }] });
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('continued') });
      await internal.settled;
      expect(await runtime.readLifecycle()).toMatchObject({
        paused: true,
        queue: [{ text: 'operator queued' }],
        operation: null,
      });
      expect(streams).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('wakes automatic work after settlement without a prompt waiter', async () => {
    const { repository, models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    const frames: Record<string, unknown>[] = [];
    runtime.onPresentationFrame((frame) => frames.push(frame));
    try {
      await runtime.enqueueAutomatic('first');
      await waitFor(() => streams.length === 1);
      await runtime.enqueueAutomatic('second');
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('one') });
      await waitFor(() => streams.length === 2);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('two') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      await waitFor(() => frames.filter((frame) => frame.type === 'agent_settled').length === 2);
      const markers = (await runtime.readEntries()).entries.filter(
        (entry) => entry.type === 'custom' && entry.customType === 'doompi.agent-settled',
      );
      expect(markers.map((entry) => entry.type === 'custom' && entry.data)).toEqual(
        frames.filter((frame) => frame.type === 'agent_settled').map(({ runId, timestamp }) => ({ runId, timestamp })),
      );
      expect(frames.filter((frame) => frame.type === 'lifecycle_update').at(-1)).toMatchObject({
        lifecycle: { operation: null, queue: [] },
      });
    } finally {
      await runtime.dispose();
    }
  });
  it('does not idle a successor admitted while prior event delivery is pending', async () => {
    const { repository, models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    const frames: Record<string, unknown>[] = [];
    const ends: { successorActive?: boolean }[] = [];
    runtime.onPresentationFrame((frame) => frames.push(frame));
    runtime.onEvent((event) => {
      if (event.type === 'run_end') ends.push(event);
    });
    runtime.onEvent(async (event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant' && !blocked) {
        blocked = true;
        await gate;
      }
    });
    try {
      const first = await runtime.submitPrompt('first');
      await waitFor(() => streams.length === 1);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('one') });
      await waitFor(() => blocked);
      const second = await runtime.submitPrompt('second');
      await waitFor(() => streams.length === 2);
      release();
      await waitFor(() => ends.length === 1);
      expect(ends[0]?.successorActive).toBe(true);
      expect(frames.filter((frame) => frame.type === 'agent_end' || frame.type === 'agent_settled')).toHaveLength(0);
      expect((await runtime.readLifecycle()).operation).not.toBeNull();
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('two') });
      await first.settled;
      await second.settled;
    } finally {
      release();
      await runtime.dispose();
    }
  });

  it('pauses queued work on abort until explicit resume and then dispatches it once', async () => {
    const { repository, models, streams, streamSimple } = fixtures();
    const session = repository;
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: session, models, model });
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
    const session = repository;
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: session, models, model });
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
  it('pops queued follow-up and next-run inputs FIFO after normal settlement', async () => {
    const { repository, models, streams, streamSimple } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    try {
      const active = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      await runtime.followUp('voice');
      await runtime.nextRun('next');
      expect((await runtime.readLifecycle()).queue).toMatchObject([
        { text: 'voice', scheduling: 'automatic', disposition: 'pending' },
        { text: 'next', scheduling: 'automatic', disposition: 'pending' },
      ]);
      expect(streams).toHaveLength(1);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('first') });
      await waitFor(() => streams.length === 2);
      expect(JSON.stringify(streamSimple.mock.calls[1]![1])).toContain('voice');
      expect(JSON.stringify(streamSimple.mock.calls[1]![1])).not.toContain('next');
      expect((await runtime.readLifecycle()).queue).toMatchObject([{ text: 'next', disposition: 'pending' }]);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('second') });
      await waitFor(() => streams.length === 3);
      expect(JSON.stringify(streamSimple.mock.calls[2]![1])).toContain('next');
      streams[2]!.push({ type: 'done', reason: 'stop', message: message('third') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      await active.settled;
      expect((await runtime.readLifecycle()).queue).toEqual([]);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('persists cancellation intent when native abort fails and retries it on recovery', async () => {
    const { repository, models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    try {
      const active = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const abortTask = vi.spyOn(runtime.lane, 'abort').mockRejectedValueOnce(new Error('interrupted abort admission'));
      await expect(runtime.abort()).rejects.toThrow('interrupted abort admission');
      expect((await runtime.readLifecycle()).paused).toBe(true);
      await runtime.recover();
      expect(abortTask).toHaveBeenCalledTimes(2);
      await active.settled.catch(() => undefined);
      expect((await runtime.readLifecycle()).operation).toBeNull();
    } finally {
      await runtime.dispose();
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
    let failed = false;
    const commit = runtime.harness.commit.bind(runtime.harness);
    const failMarker = vi.spyOn(runtime.harness, 'commit').mockImplementation((change, ctx) =>
      commit(
        (tx) =>
          change(
            new Proxy(tx, {
              get(target, key) {
                if (key === 'appendEntry')
                  return async (...args: Parameters<typeof target.appendEntry>) => {
                    const draft: unknown = args[1];
                    if (
                      !failed &&
                      typeof draft === 'object' &&
                      draft !== null &&
                      'kind' in draft &&
                      draft.kind === 'doompi.agent-settled'
                    ) {
                      failed = true;
                      throw new Error('marker unavailable');
                    }
                    return target.appendEntry(...args);
                  };
                const value: unknown = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ),
        ctx,
      ),
    );
    try {
      const first = await runtime.submitPrompt('first');
      await waitFor(() => streams.length === 1);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('one') });
      await first.settled;
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(failMarker).toHaveBeenCalled();
      expect(failed).toBe(true);
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

  it('promotes busy queued work at the native boundary without aborting or pausing automatic neighbors', async () => {
    const { repository, models, streams, streamSimple } = fixtures(true);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    try {
      const active = await runtime.submitPrompt('active');
      await waitFor(() => streams.length === 1);
      const signal = streamSimple.mock.calls[0]![2]!.signal!;
      const selected = await runtime.enqueueAutomatic('selected-boundary');
      const neighbor = await runtime.enqueueAutomatic('neighbor-after-complete');
      const id = (await runtime.readLifecycle()).operation!.id;
      expect(await runtime.readLifecycle()).toMatchObject({ paused: false });
      expect(await runtime.promoteQueued(selected.id, id)).toBe('promoted');
      expect(signal.aborted).toBe(false);
      expect(streams).toHaveLength(1);
      expect(await runtime.readLifecycle()).toMatchObject({
        paused: false,
        queue: [
          { id: selected.id, disposition: 'handoff' },
          { id: neighbor.id, disposition: 'pending' },
        ],
      });
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('boundary') });
      await waitFor(() => streams.length === 2);
      const boundaryContext = JSON.stringify(streamSimple.mock.calls[1]![1]);
      expect(boundaryContext.split('selected-boundary')).toHaveLength(2);
      expect(boundaryContext).not.toContain('neighbor-after-complete');
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('selected answer') });
      await active.settled;
      await waitFor(() => streams.length === 3);
      const neighborContext = JSON.stringify(streamSimple.mock.calls[2]![1]);
      expect(neighborContext.split('selected-boundary')).toHaveLength(2);
      expect(neighborContext.split('neighbor-after-complete')).toHaveLength(2);
      streams[2]!.push({ type: 'done', reason: 'stop', message: message('neighbor answer') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: false, queue: [] });
      expect(streams).toHaveLength(3);
    } finally {
      await runtime.dispose();
    }
  });

  it('removes one pending item without replaying its neighbors and promotes by stable identity', async () => {
    const { repository, models, streams } = fixtures();
    const session = repository;
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: session, models, model });
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
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('boundary') });
      await waitFor(() => streams.length === 2);
      expect((await runtime.readLifecycle()).queue.map((item) => item.id)).toEqual([last.id]);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('selected') });
      await waitFor(() => streams.length === 3);
      streams[2]!.push({ type: 'done', reason: 'stop', message: message('neighbor') });
      await active.settled.catch(() => undefined);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('does not resurrect an input removed while promotion is awaiting its commit', async () => {
    const { repository, models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    const gate = { promise: Promise.resolve(), resolve: () => {} };
    gate.promise = new Promise<void>((resolve) => {
      gate.resolve = resolve;
    });
    let blocked = false;
    try {
      await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const queued = await runtime.enqueueAutomatic('must not run');
      const operationId = (await runtime.readLifecycle()).operation!.id;
      const commit = runtime.harness.commit.bind(runtime.harness);
      vi.spyOn(runtime.harness, 'commit').mockImplementationOnce(async (change, context) => {
        blocked = true;
        await gate.promise;
        return commit(change, context);
      });
      const submit = vi.spyOn(runtime.lane, 'submit');
      const promoting = runtime.promoteQueued(queued.id, operationId);
      await waitFor(() => blocked);
      expect(await runtime.removeQueued(queued.id)).toBe('removed');
      gate.resolve();
      expect(await promoting).toBe('not_found');
      expect(submit).not.toHaveBeenCalled();
      expect((await runtime.readLifecycle()).queue).toEqual([]);
    } finally {
      gate.resolve();
      await runtime.dispose();
    }
  });

  it('does not report removal when a concurrent handoff already claimed the input', async () => {
    const { repository, models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    const gate = { promise: Promise.resolve(), resolve: () => {} };
    gate.promise = new Promise<void>((resolve) => {
      gate.resolve = resolve;
    });
    let blocked = false;
    try {
      await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const queued = await runtime.enqueueAutomatic('claimed');
      const operationId = (await runtime.readLifecycle()).operation!.id;
      const commit = runtime.harness.commit.bind(runtime.harness);
      vi.spyOn(runtime.harness, 'commit').mockImplementationOnce(async (change, context) => {
        blocked = true;
        await gate.promise;
        return commit(change, context);
      });
      const removing = runtime.removeQueued(queued.id);
      await waitFor(() => blocked);
      expect(await runtime.promoteQueued(queued.id, operationId)).toBe('promoted');
      gate.resolve();
      expect(await removing).toBe('in_flight');
      expect((await runtime.readLifecycle()).queue).toMatchObject([{ id: queued.id, disposition: 'handoff' }]);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('boundary') });
      await waitFor(() => streams.length === 2);
      expect(await runtime.removeQueued(queued.id)).toBe('already_consumed');
      expect((await runtime.readLifecycle()).queue).toEqual([]);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
    } finally {
      gate.resolve();
      await runtime.dispose();
    }
  });

  it('claims a pending follow-up before promoting it to steer', async () => {
    const { repository, models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    const gate = { promise: Promise.resolve(), resolve: () => {} };
    gate.promise = new Promise<void>((resolve) => {
      gate.resolve = resolve;
    });
    let blocked = false;
    try {
      await runtime.submitPrompt('active');
      await waitFor(() => streams.length === 1);
      await runtime.followUp('pending');
      const queued = (await runtime.readLifecycle()).queue[0]!;
      const commit = runtime.harness.commit.bind(runtime.harness);
      vi.spyOn(runtime.harness, 'commit').mockImplementationOnce(async (change, context) => {
        const result = await commit(change, context);
        blocked = true;
        await gate.promise;
        return result;
      });
      expect(queued).toMatchObject({ scheduling: 'automatic', disposition: 'pending' });
      const starting = runtime.promoteQueued(queued.id, (await runtime.readLifecycle()).operation!.id);
      await waitFor(() => blocked);
      expect((await runtime.readLifecycle()).queue).toMatchObject([{ id: queued.id, disposition: 'handoff' }]);
      gate.resolve();
      expect(await starting).toBe('promoted');
      expect((await runtime.readLifecycle()).queue).toMatchObject([{ id: queued.id, disposition: 'handoff' }]);
      expect(await runtime.promoteQueued(queued.id)).toBe('in_flight');
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('boundary') });
      await waitFor(() => streams.length === 2);
      expect((await runtime.readLifecycle()).queue).toEqual([]);
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
    } finally {
      gate.resolve();
      await runtime.dispose();
    }
  });

  it('starts persisted idle automatic work when reopening the session', async () => {
    const { repository, models, streams } = fixtures();
    const session = repository;
    const persisted = createSession(session);
    const Lifecycle = defineDoc({
      kind: 'doompi.server.lifecycle',
      version: 1,
      scope: 'session',
      initial: () => ({ json: '' }),
    });
    await persisted.commit(async (tx) => {
      (await tx.doc(Lifecycle)).json = JSON.stringify({
        revision: 1,
        paused: false,
        queue: [
          { id: 'recovered', text: 'next', delivery: 'followUp', scheduling: 'automatic', disposition: 'pending' },
        ],
      });
    }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: session, models, model });
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
  it('admits immediate user input while preserving paused queued inputs with images', async () => {
    const { repository, models, streams } = fixtures(true);
    const session = repository;
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: session, models, model });
    const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
    try {
      const first = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      await runtime.followUp('follow-up', [image]);
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
      await waitFor(() => streams.length === 4);
      streams[3]!.push({ type: 'done', reason: 'stop', message: message('last') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect((await runtime.readLifecycle()).queue).toEqual([]);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('sends one selected paused input from idle and rejects stale active targets', async () => {
    const { repository, models, streams } = fixtures(true);
    const session = repository;
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: session, models, model });
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
    const session = repository;
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: session, models, model });
    try {
      const first = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      let releaseAbort!: () => void;
      const abortGate = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      const nativeAbort = runtime.lane.abort.bind(runtime.lane);
      vi.spyOn(runtime.lane, 'abort').mockImplementationOnce(async (...args) => {
        await abortGate;
        return nativeAbort(...args);
      });
      const replacement = runtime.submitUserPrompt('voice now');
      await waitFor(async () => (await runtime.readLifecycle()).operation?.status === 'aborting');
      await expect(runtime.submitPrompt('competitor')).rejects.toThrow('interruption');
      await expect(runtime.submitUserPrompt('second interruption')).rejects.toThrow('interruption');
      await expect(runtime.resumeQueue()).rejects.toThrow('interruption');
      await expect(runtime.compact()).rejects.toThrow('interruption');
      await expect(runtime.navigateTree(null)).rejects.toThrow('interruption');
      const retained = await runtime.enqueueAutomatic('retained');
      expect(await runtime.removeQueued(retained.id)).toBe('removed');
      releaseAbort();
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
  it('serializes user admissions after asynchronous command dispatch', async () => {
    const { repository, models } = fixtures(true);
    let release!: () => void;
    const commands = new Promise<false>((resolve) => {
      release = () => resolve(false);
    });
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      durableStorage: repository,
      models,
      model,
      dispatchCommand: () => commands,
    });
    try {
      const outcomes = Promise.allSettled([runtime.submitUserPrompt('first'), runtime.submitUserPrompt('second')]);
      release();
      const [first, second] = await outcomes;
      expect(first.status).toBe('fulfilled');
      expect(second).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'A user interruption is already being admitted' }),
      });
    } finally {
      release();
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('does not resurrect fresh user input removed before its admission claim', async () => {
    const { repository, models } = fixtures(true);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    let armed = false;
    const commit = runtime.harness.commit.bind(runtime.harness);
    runtime.onPresentationFrame((frame) => {
      if (frame.type !== 'lifecycle_update' || armed) return;
      armed = true;
      vi.spyOn(runtime.harness, 'commit').mockImplementationOnce(async (change, context) => {
        blocked = true;
        await gate;
        return commit(change, context);
      });
    });
    const submit = vi.spyOn(runtime.lane, 'submit');
    try {
      const admitting = runtime.submitUserPrompt('removed');
      void admitting.catch(() => undefined);
      await waitFor(() => blocked);
      const queued = (await runtime.readLifecycle()).queue[0]!;
      expect(await runtime.removeQueued(queued.id)).toBe('removed');
      release();
      await expect(admitting).rejects.toThrow('removed before admission');
      expect(submit).not.toHaveBeenCalled();
    } finally {
      release();
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('reconciles a selected native acceptance with a lost acknowledgement without retrying', async () => {
    const { repository, models, streams } = fixtures(true);
    const session = repository;
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: session, models, model });
    try {
      const first = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const selected = await runtime.enqueueAutomatic('selected');
      const id = (await runtime.readLifecycle()).operation!.id;
      const commit = runtime.harness.commit.bind(runtime.harness);
      let accepted = false;
      vi.spyOn(runtime.harness, 'commit').mockImplementationOnce(async (change, context) => {
        await commit(change, context);
        accepted = true;
        throw new Error('acknowledgement lost');
      });
      expect(await runtime.promoteQueued(selected.id, id)).toBe('promoted');
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('boundary') });
      await waitFor(() => streams.length === 2);
      expect(accepted).toBe(true);
      await runtime.recover();
      expect(await runtime.removeQueued(selected.id)).toBe('already_consumed');
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(streams).toHaveLength(2);
      await first.settled;
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('waits for signal-aware tool cleanup before starting the replacement provider', async () => {
    const { repository, models, streams } = fixtures();
    const session = repository;
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
      durableStorage: session,
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

  it('promotes an idle automatic input without pausing its unpaused neighbors', async () => {
    const { repository, models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    const Lifecycle = defineDoc({
      kind: 'doompi.server.lifecycle',
      version: 1,
      scope: 'session',
      initial: () => ({ json: '' }),
    });
    try {
      await runtime.harness.commit(async (tx) => {
        (await tx.doc(Lifecycle)).json = JSON.stringify({
          revision: 1,
          paused: false,
          queue: ['selected', 'neighbor'].map((id) => ({
            id,
            text: id,
            delivery: 'followUp',
            scheduling: 'automatic',
            disposition: 'pending',
          })),
        });
      }, BACKGROUND_CONTEXT);
      expect(await runtime.promoteQueued('selected')).toBe('promoted');
      await waitFor(() => streams.length === 1);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await waitFor(() => streams.length === 2);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: false });
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('neighbor answer') });
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: false, queue: [] });
      expect(streams).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });
  it('resumes the exact accepted user replacement without unpausing retained inputs', async () => {
    const { repository, models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    try {
      const active = await runtime.submitPrompt('long');
      await waitFor(() => streams.length === 1);
      const retained = await runtime.enqueueAutomatic('later');
      const replacement = await runtime.submitUserPrompt('voice');
      await active.settled;
      await waitFor(() => streams.length === 2);
      const resumed = await runtime.admitResume();
      expect(resumed.resumed).toBe(true);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: true, queue: [{ id: retained.id }] });
      streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
      await replacement.settled;
      await resumed.settled;
      expect(streams).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });
  it.each(['completed', 'replaced', 'aborting'] as const)(
    'keeps selected promotion pending when its native target is %s before admission',
    async (race) => {
      const { repository, models, streams } = fixtures();
      const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let blocked = false;
      try {
        await runtime.submitPrompt('active');
        await waitFor(() => streams.length === 1);
        const selected = await runtime.enqueueAutomatic('selected-race');
        const operationId = (await runtime.readLifecycle()).operation!.id;
        const commit = runtime.harness.commit.bind(runtime.harness);
        vi.spyOn(runtime.harness, 'commit').mockImplementationOnce(async (change, ctx) => {
          blocked = true;
          await gate;
          return commit(change, ctx);
        });
        const promoting = runtime.promoteQueued(selected.id, operationId);
        await waitFor(() => blocked);
        if (race === 'completed') {
          streams[0]!.push({ type: 'done', reason: 'stop', message: message('done') });
          await runtime.lane.waitForIdle(BACKGROUND_CONTEXT);
        } else {
          await runtime.lane.abort(BACKGROUND_CONTEXT);
          if (race === 'replaced') {
            await runtime.lane.waitForIdle(BACKGROUND_CONTEXT);
            await runtime.lane.submit(
              { type: 'input', content: 'replacement', whenBusy: 'reject' },
              BACKGROUND_CONTEXT,
            );
            await waitFor(() => streams.length === 2);
          }
        }
        release();
        expect(await promoting).toBe('target_changed');
        expect((await runtime.readLifecycle()).queue).toMatchObject([{ id: selected.id, disposition: 'pending' }]);
      } finally {
        release();
        await runtime.dispose();
      }
    },
  );

  it('keeps an idle selection pending when a native run starts before its admission commit', async () => {
    const { repository, models, streams } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    try {
      const selected = await runtime.enqueueAutomatic('idle-selection');
      const commit = runtime.harness.commit.bind(runtime.harness);
      vi.spyOn(runtime.harness, 'commit').mockImplementationOnce(async (change, ctx) => {
        blocked = true;
        await gate;
        return commit(change, ctx);
      });
      const promoting = runtime.promoteQueued(selected.id);
      await waitFor(() => blocked);
      await runtime.lane.submit({ type: 'input', content: 'native-active', whenBusy: 'reject' }, BACKGROUND_CONTEXT);
      await waitFor(() => streams.length === 1);
      release();
      expect(await promoting).toBe('target_changed');
      expect((await runtime.readLifecycle()).queue).toMatchObject([{ id: selected.id, disposition: 'pending' }]);
    } finally {
      release();
      await runtime.dispose();
    }
  });

  it.each(['one-at-a-time', 'all'] as const)(
    'preserves the idle native inbox final boundary in %s mode',
    async (mode) => {
      const { repository, models, streams, streamSimple } = fixtures();
      const runtime = await createDirectHarnessRuntime({
        cwd: '/tmp',
        durableStorage: repository,
        models,
        model,
        steeringMode: mode,
        followUpMode: mode,
      });
      try {
        const selected = await runtime.enqueueAutomatic('selected-after-native');
        await runtime.harness.commit(async (tx) => {
          const inbox = await tx.doc(InboxDoc, runtime.lane.id);
          for (const [content, delivery] of [
            ['native-steer-first', 'steer'],
            ['native-steer-second', 'steer'],
            ['native-follow-first', 'followUp'],
            ['native-follow-second', 'followUp'],
          ] as const) {
            const submission = await tx.createSubmission({
              conversationId: runtime.lane.id,
              type: 'input',
              status: 'queued',
            });
            inbox.items.push({ id: submission.id, mode: delivery, content });
          }
        }, BACKGROUND_CONTEXT);
        expect(await runtime.promoteQueued(selected.id)).toBe('promoted');
        await waitFor(() => streams.length === 1);
        const first = JSON.stringify(streamSimple.mock.calls[0]![1]);
        expect(first).toContain('native-steer-first');
        expect(first).toContain('native-follow-first');
        expect(first.indexOf('native-steer-first')).toBeLessThan(first.indexOf('native-follow-first'));
        if (mode === 'all') {
          expect(first).toContain('native-steer-second');
          expect(first).toContain('native-follow-second');
          expect(first).toContain('selected-after-native');
          expect((await runtime.readLifecycle()).queue).toEqual([]);
        } else {
          expect(first).not.toContain('native-steer-second');
          expect(first).not.toContain('selected-after-native');
          expect((await runtime.readLifecycle()).queue).toMatchObject([{ id: selected.id, disposition: 'handoff' }]);
          streams[0]!.push({ type: 'done', reason: 'stop', message: message('first boundary') });
          await waitFor(() => streams.length === 2);
          const second = JSON.stringify(streamSimple.mock.calls[1]![1]);
          expect(second).toContain('native-steer-second');
          expect(second).toContain('native-follow-second');
          expect(second).not.toContain('selected-after-native');
          streams[1]!.push({ type: 'done', reason: 'stop', message: message('second boundary') });
          await waitFor(() => streams.length === 3);
          expect(JSON.stringify(streamSimple.mock.calls[2]![1])).toContain('selected-after-native');
        }
      } finally {
        await runtime.dispose();
      }
    },
  );

  it('deduplicates accepted promotion before rechecking a replaced target after lost acknowledgement', async () => {
    const { repository, models, streams, streamSimple } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    try {
      await runtime.submitPrompt('active');
      await waitFor(() => streams.length === 1);
      const selected = await runtime.enqueueAutomatic('accepted-once');
      const operationId = (await runtime.readLifecycle()).operation!.id;
      const commit = runtime.harness.commit.bind(runtime.harness);
      vi.spyOn(runtime.harness, 'commit').mockImplementationOnce(async (change, ctx) => {
        await commit(change, ctx);
        streams[0]!.push({ type: 'done', reason: 'stop', message: message('boundary') });
        await waitFor(() => streams.length === 2);
        streams[1]!.push({ type: 'done', reason: 'stop', message: message('selected done') });
        await runtime.lane.waitForIdle(BACKGROUND_CONTEXT);
        await runtime.lane.submit({ type: 'input', content: 'new target', whenBusy: 'reject' }, BACKGROUND_CONTEXT);
        await waitFor(() => streams.length === 3);
        throw new Error('acknowledgement lost after replacement');
      });
      expect(await runtime.promoteQueued(selected.id, operationId)).toBe('promoted');
      await runtime.recover();
      expect(streams).toHaveLength(3);
      expect(JSON.stringify(streamSimple.mock.calls[2]![1]).split('accepted-once')).toHaveLength(2);
      const entries = (await runtime.readEntries()).entries;
      expect(
        entries.filter(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'user' &&
            JSON.stringify(entry.message.content).includes('accepted-once'),
        ),
      ).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('places idle native writes before selected input and settles stale heads like a final boundary', async () => {
    const { repository, models, streams, streamSimple } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    try {
      const selected = await runtime.enqueueAutomatic('after-reset');
      const staleId = await runtime.harness.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, runtime.lane.id);
        const old = await tx.appendEntry(runtime.lane.id, {
          kind: 'test.old',
          model: [{ role: 'user', content: 'old-range', timestamp: 1 }],
        });
        const reset = await tx.createSubmission({ conversationId: runtime.lane.id, type: 'write', status: 'queued' });
        const stale = await tx.createSubmission({ conversationId: runtime.lane.id, type: 'write', status: 'queued' });
        inbox.items.push({
          id: reset.id,
          mode: 'write',
          entry: { kind: 'test.reset', head: 'self', model: [{ role: 'user', content: 'reset-range', timestamp: 2 }] },
        });
        inbox.items.push({ id: stale.id, mode: 'write', entry: { kind: 'test.stale', head: old.id } });
        return stale.id;
      }, BACKGROUND_CONTEXT);
      expect(await runtime.promoteQueued(selected.id)).toBe('promoted');
      await waitFor(() => streams.length === 1);
      const first = JSON.stringify(streamSimple.mock.calls[0]![1]);
      expect(first).not.toContain('old-range');
      expect(first).toContain('reset-range');
      expect(first.indexOf('reset-range')).toBeLessThan(first.indexOf('after-reset'));
      expect(
        await (await runtime.harness.submission(staleId, BACKGROUND_CONTEXT))!.status(BACKGROUND_CONTEXT),
      ).toMatchObject({ status: 'unanswered', reason: 'stale' });
      expect((await runtime.harness.snapshot(InboxDoc, runtime.lane.id, BACKGROUND_CONTEXT))!.items).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
  it.each([false, true])(
    'checks native compaction foreground ownership atomically (background: %s)',
    async (background) => {
      const { repository, models } = fixtures();
      const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let blocked = false;
      try {
        const selected = await runtime.enqueueAutomatic('after-compaction');
        const commit = runtime.harness.commit.bind(runtime.harness);
        vi.spyOn(runtime.harness, 'commit').mockImplementationOnce(async (change, ctx) => {
          blocked = true;
          await gate;
          return commit(change, ctx);
        });
        const promoting = runtime.promoteQueued(selected.id);
        await waitFor(() => blocked);
        await commit(
          (tx) =>
            tx.createTask(
              CompactionTask,
              { reason: 'manual' },
              {
                ownership: { kind: 'conversation' },
                conversationId: runtime.lane.id,
                background,
              },
            ),
          BACKGROUND_CONTEXT,
        );
        release();
        expect(await promoting).toBe(background ? 'promoted' : 'target_changed');
        if (!background) {
          expect((await runtime.readLifecycle()).queue).toMatchObject([{ id: selected.id, disposition: 'pending' }]);
          expect((await runtime.harness.snapshot(LiveDoc, runtime.lane.id, BACKGROUND_CONTEXT))?.run).toBeUndefined();
        } else {
          expect((await runtime.harness.snapshot(LiveDoc, runtime.lane.id, BACKGROUND_CONTEXT))?.run).toBeDefined();
        }
      } finally {
        release();
        await runtime.dispose();
      }
    },
  );
  it.each(['abort', 'failure', 'custom abort', 'custom failure'] as const)(
    'reconciles internal delivery after SQLite restart following %s',
    async (outcome) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-internal-restart-'));
      const { models, streams, streamSimple } = fixtures(true);
      const transformed: unknown[][] = [];
      const open = () =>
        createDirectHarnessRuntime({
          cwd: root,
          sessionsRoot: root,
          sessionId: 'internal_restart',
          storage: 'sqlite' as const,
          historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
          models,
          model,
          transformContext: async ({ messages }) => {
            transformed.push(messages);
            return { messages };
          },
        });
      let runtime = await open();
      try {
        const active = await runtime.submitPrompt('operator');
        void active.settled.catch(() => undefined);
        await waitFor(() => streams.length === 1);
        const submit = runtime.lane.submit.bind(runtime.lane);
        const blocked = vi.spyOn(runtime.lane, 'submit').mockImplementation(async (draft, ctx) => {
          if (draft.requestId?.endsWith(':context')) throw new Error('Simulated unavailable fallback');
          return submit(draft, ctx);
        });
        const internal = await runtime.submitInternalMessage(
          outcome.startsWith('custom')
            ? {
                role: 'custom',
                customType: 'restart-result',
                content: 'restart contribution',
                display: true,
                details: { source: 'runner', nested: { receipt: 7 } },
                timestamp: 1,
              }
            : 'restart contribution',
          'followUp',
        );
        void internal.settled.catch(() => undefined);
        if (outcome.endsWith('abort')) await expect(runtime.abort()).rejects.toThrow('Simulated unavailable fallback');
        else
          streams[0]!.push({
            type: 'error',
            reason: 'error',
            error: {
              ...message('failed'),
              stopReason: 'error',
              errorMessage: 'provider failed',
            },
          });
        await expect(internal.settled).rejects.toThrow('Simulated unavailable fallback');
        await runtime.dispose();
        blocked.mockRestore();
        runtime = await open();
        await runtime.recover();
        await runtime.recover();
        expect(streams).toHaveLength(1);
        expect((await runtime.readLifecycle()).queue).toEqual([]);
        expect((await runtime.readState()).pendingMessageCount).toBe(0);
        const view = await runtime.lane.context(BACKGROUND_CONTEXT);
        expect(JSON.stringify(view.messages).split('restart contribution')).toHaveLength(2);
        if (outcome.startsWith('custom')) {
          const entries = (await runtime.readEntries()).entries;
          expect(entries.filter((e) => e.type === 'message' && e.message.role === 'custom')).toHaveLength(1);
          const envelope = view.entries.find(
            (e) => e.kind === 'doompi.entry' && JSON.stringify(e.data).includes('restart-result'),
          )!;
          expect(JSON.stringify(view.contributions[view.entries.indexOf(envelope)])).toContain('restart contribution');
          expect(
            view.entries.filter((e) => e.model?.some((m) => JSON.stringify(m).includes('restart contribution'))),
          ).toHaveLength(0);
        }
        await runtime.dispose();
        runtime = await open();
        await runtime.recover();
        const next = await runtime.submitPrompt('ordinary user');
        await waitFor(() => streams.length === 2);
        expect(JSON.stringify(streamSimple.mock.calls[1]![1]).split('restart contribution')).toHaveLength(2);
        if (outcome.startsWith('custom'))
          expect(transformed.at(-1)).toContainEqual(
            expect.objectContaining({
              role: 'custom',
              customType: 'restart-result',
              details: { source: 'runner', nested: { receipt: 7 } },
            }),
          );
        streams[1]!.push({ type: 'done', reason: 'stop', message: message('answer') });
        await next.settled;
      } finally {
        await runtime.dispose();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['before admission', 'stranded queue', 'after context receipt'] as const)(
    'recovers reconciliation-only records %s without starting an agent',
    async (phase) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-internal-window-'));
      const { models, streams } = fixtures();
      const open = () =>
        createDirectHarnessRuntime({
          cwd: root,
          sessionsRoot: root,
          sessionId: 'internal_window',
          storage: 'sqlite' as const,
          historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
          models,
          model,
        });
      const Lifecycle = defineDoc({
        kind: 'doompi.server.lifecycle',
        version: 1,
        scope: 'session',
        initial: () => ({ json: '' }),
      });
      let runtime = await open();
      try {
        const custom = {
          role: 'custom' as const,
          customType: 'window-result',
          content: 'window contribution',
          display: true,
          details: { original: true },
          timestamp: 1,
        };
        if (phase === 'after context receipt') {
          const envelope = await (
            await runtime.lane.submit(
              {
                type: 'write',
                requestId: 'window:message',
                entry: {
                  kind: 'doompi.entry',
                  data: { type: 'message', message: custom, inputRequestId: 'window' },
                },
              },
              BACKGROUND_CONTEXT,
            )
          ).wait(BACKGROUND_CONTEXT);
          if (envelope.status !== 'done') throw new Error('Envelope not placed');
          await (
            await runtime.lane.submit(
              {
                type: 'write',
                requestId: 'window:context',
                entry: {
                  kind: 'doompi.entry',
                  edits: [
                    {
                      target: envelope.entry,
                      action: 'replace',
                      messages: [{ role: 'user', content: custom.content, timestamp: 1 }],
                    },
                  ],
                },
              },
              BACKGROUND_CONTEXT,
            )
          ).wait(BACKGROUND_CONTEXT);
        }
        await runtime.harness.commit(async (tx) => {
          const doc = await tx.doc(Lifecycle);
          const record = JSON.parse(doc.json || '{"revision":0,"paused":false,"queue":[]}');
          record.internalDeliveries = { window: { message: custom, conversationId: runtime.lane.id } };
          if (phase === 'stranded queue') {
            // Reconstruct the crash window after native admission but before the product receipt.
            const inbox = await tx.doc(InboxDoc, runtime.lane.id);
            for (const id of ['window', 'second']) {
              const submission = await tx.createSubmission({
                conversationId: runtime.lane.id,
                requestId: id,
                type: 'input',
                status: 'queued',
              });
              inbox.items.push({
                id: submission.id,
                mode: 'followUp',
                content: id === 'window' ? custom.content : 'second contribution',
              });
              if (id === 'second')
                record.internalDeliveries.second = {
                  message: { role: 'user', content: 'second contribution', timestamp: 1 },
                  conversationId: runtime.lane.id,
                };
            }
          }
          doc.json = JSON.stringify(record);
        }, BACKGROUND_CONTEXT);
        await runtime.dispose();
        runtime = await open();
        await runtime.recover();
        await runtime.recover();
        expect(streams).toHaveLength(0);
        expect((await runtime.readState()).pendingMessageCount).toBe(0);
        expect((await runtime.readLifecycle()).queue).toEqual([]);
        expect(
          JSON.stringify((await runtime.lane.context(BACKGROUND_CONTEXT)).messages).split(custom.content),
        ).toHaveLength(2);
        if (phase === 'stranded queue')
          expect(
            JSON.stringify((await runtime.lane.context(BACKGROUND_CONTEXT)).messages).split('second contribution'),
          ).toHaveLength(2);
        expect(
          (await runtime.readEntries()).entries.filter((e) => e.type === 'message' && e.message.role === 'custom'),
        ).toHaveLength(1);
      } finally {
        await runtime.dispose();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
