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
import { MemoryStorage, createSession, defineDoc } from '@earendil-works/pi-durable';
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
  it('keeps a held extension follow-up dormant until a later explicit turn', async () => {
    const { repository, models, streams } = fixtures();
    const session = repository;
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: session, models, model });
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
      await waitFor(() => streams.length === 2);
      expect((await runtime.readLifecycle()).queue.map((item) => item.id)).toEqual([last.id]);
      await runtime.abort(id);
      streams[0]!.push({ type: 'done', reason: 'stop', message: message('late') });
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
      expect(await removing).toBe('already_consumed');
      expect((await runtime.readLifecycle()).queue).toEqual([]);
    } finally {
      gate.resolve();
      await runtime.dispose();
    }
  });

  it('claims held writes before submitting them for the next prompt', async () => {
    const { repository, models } = fixtures();
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: repository, models, model });
    const gate = { promise: Promise.resolve(), resolve: () => {} };
    gate.promise = new Promise<void>((resolve) => {
      gate.resolve = resolve;
    });
    let blocked = false;
    try {
      await runtime.nextRun('held');
      const queued = (await runtime.readLifecycle()).queue[0]!;
      const submit = runtime.lane.submit.bind(runtime.lane);
      vi.spyOn(runtime.lane, 'submit').mockImplementationOnce(async (draft, context) => {
        blocked = true;
        await gate.promise;
        return submit(draft, context);
      });
      const starting = runtime.submitPrompt('explicit');
      await waitFor(() => blocked);
      expect(await runtime.removeQueued(queued.id)).toBe('in_flight');
      gate.resolve();
      await starting;
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
  it('admits immediate user input while preserving paused automatic and held inputs with images', async () => {
    const { repository, models, streams } = fixtures(true);
    const session = repository;
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', durableStorage: session, models, model });
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
      const accept = runtime.lane.submit.bind(runtime.lane);
      const spy = vi.spyOn(runtime.lane, 'submit').mockImplementationOnce(async (...args) => {
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

  it('sends only the selected idle automatic input even when its neighbors were unpaused', async () => {
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
      await waitFor(async () => (await runtime.readLifecycle()).operation === null);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: true, queue: [{ id: 'neighbor' }] });
      expect(streams).toHaveLength(1);
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
});
