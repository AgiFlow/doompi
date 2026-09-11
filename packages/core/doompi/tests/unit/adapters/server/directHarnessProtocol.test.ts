import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHistoryOwnership } from '../../../../src/adapters/serialization/historyOwnership.ts';
import { serveSessionSocket } from '../../../../src/adapters/server/socketServer.ts';
import { createFrameDecoder, encodeFrame } from '../../../../src/services/server/sessionFraming.ts';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { createDirectHarnessRuntime } from '../../../../src/adapters/server/directHarnessRuntime.ts';

type Frame = Record<string, unknown>;

type ModelCall = Parameters<Models['streamSimple']>;

const modelA: Model<Api> = {
  id: 'model-a',
  name: 'Model A',
  api: 'test-api',
  provider: 'test-provider-a',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65_536,
  maxTokens: 256,
};

const modelB: Model<Api> = {
  ...modelA,
  id: 'model-b',
  name: 'Model B',
  provider: 'test-provider-b',
};

const models = {
  getModels: () => [modelA, modelB],
  getModel: (provider: string, id: string) =>
    [modelA, modelB].find((candidate) => candidate.provider === provider && candidate.id === id),
  getAvailable: async () => [modelA, modelB],
} as unknown as Models;

function assistantMessage(model: Model<Api>, text: string, stopReason: 'stop' | 'aborted' = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason,
    ...(stopReason === 'aborted' ? { errorMessage: 'aborted' } : {}),
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

async function waitForFrame(frames: Frame[], predicate: (frame: Frame) => boolean, label: string): Promise<Frame> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const frame = frames.find(predicate);
    if (frame !== undefined) return frame;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function request(
  runtime: Awaited<ReturnType<typeof createDirectHarnessRuntime>>,
  frames: Frame[],
  id: string,
  type: string,
  fields: Frame = {},
): Promise<Frame> {
  runtime.send({ type, id, ...fields });
  return waitForFrame(frames, (frame) => frame.id === id, `${type} response`);
}

describe('direct AgentHarness protocol acceptance', () => {
  it('authenticates a real socket, replays a detached run, and resumes disk history after runtime restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpi-e2e-'));
    const streamSimple = vi.fn<Models['streamSimple']>((requestedModel) => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage(requestedModel, 'persisted answer');
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    });
    const options = {
      cwd: root,
      models: { ...models, streamSimple } as unknown as Models,
      model: modelA,
      historyOwnership: createHistoryOwnership(),
    };
    let runtime = await createDirectHarnessRuntime(options);
    const identity = runtime.harness;
    const socketPath = path.join(root, 's');
    const served = serveSessionSocket({ socketPath, token: 'e2e-attach-token', agent: runtime });
    const clients: net.Socket[] = [];
    async function connect(token: string) {
      const frames: Frame[] = [];
      const decode = createFrameDecoder();
      const socket = net.createConnection(socketPath);
      clients.push(socket);
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => frames.push(...decode(chunk)));
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(encodeFrame({ type: 'attach', token }));
      await waitForFrame(frames, () => true, 'socket handshake');
      return { socket, frames };
    }
    try {
      const denied = await connect('incorrect');
      expect(denied.frames[0]?.type).not.toBe('attached');
      expect(served.attached).toBe(false);
      expect(streamSimple).not.toHaveBeenCalled();
      const first = await connect('e2e-attach-token');
      expect(first.frames[0]?.type).toBe('attached');
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
      first.socket.write(encodeFrame({ type: 'prompt', id: 'disk-prompt', message: 'remember before restart' }));
      await expect(
        waitForFrame(first.frames, (frame) => frame.id === 'disk-prompt', 'socket prompt'),
      ).resolves.toMatchObject({ success: true });
      first.socket.destroy();
      await vi.waitFor(() => expect(served.attached).toBe(false));
      await runtime.prompt('while disconnected');
      expect(served.backlogged).toBeGreaterThan(0);
      const second = await connect('e2e-attach-token');
      expect(second.frames[0]).toMatchObject({ type: 'attached', replayed: expect.any(Number) });
      expect(second.frames[0]!.replayed).toBeGreaterThan(0);
      expect(runtime.harness).toBe(identity);
      const frames: Frame[] = [];
      runtime.onFrame((frame) => frames.push(frame));
      for (const [type, fields] of [
        ['set_session_name', { name: 'persistent name' }],
        ['set_steering_mode', { mode: 'one-at-a-time' }],
        ['set_follow_up_mode', { mode: 'all' }],
        ['set_thinking_level', { level: 'off' }],
        ['append_custom_entry', { customType: 'e2e-state', data: { retained: true } }],
      ] as const) {
        await expect(request(runtime, frames, type, type, fields)).resolves.toMatchObject({ success: true });
      }
      for (const [type, fields] of [
        ['set_model', {}],
        ['set_session_name', { name: '  ' }],
        ['set_steering_mode', { mode: 'invalid' }],
        ['set_follow_up_mode', {}],
        ['set_thinking_level', {}],
        ['navigate_tree', { targetId: 42 }],
        ['get_entries', { since: 'missing-entry' }],
        ['record_usage', {}],
        ['append_custom_entry', {}],
        ['unknown_command', {}],
      ] as const) {
        await expect(request(runtime, frames, `invalid-${type}`, type, fields)).resolves.toMatchObject({
          success: false,
        });
      }
      const state = await request(runtime, frames, 'disk-state', 'get_state');
      expect(state).toMatchObject({
        data: { sessionName: 'persistent name', steeringMode: 'one-at-a-time', followUpMode: 'all' },
      });
      await expect(request(runtime, frames, 'available', 'get_available_models')).resolves.toMatchObject({
        data: { models: [modelA, modelB] },
      });
      await expect(request(runtime, frames, 'commands', 'get_commands')).resolves.toMatchObject({
        data: { commands: [] },
      });
      const messages = await request(runtime, frames, 'messages', 'get_messages');
      expect(JSON.stringify(messages.data)).toContain('remember before restart');
      await expect(request(runtime, frames, 'stats', 'get_session_stats')).resolves.toMatchObject({ success: true });
      const sessionPath = (state.data as { sessionFile: string }).sessionFile;
      const before = await request(runtime, frames, 'disk-entries', 'get_entries');
      const entries = (before.data as { entries: Frame[] }).entries;
      const ids = entries.map((entry) => entry.id);
      second.socket.destroy();
      await served.close();
      await runtime.dispose();
      expect(fs.existsSync(`${sessionPath}.doompi-v4.lock`)).toBe(false);
      // Queue policy is host configuration, not journal state; reapply it explicitly.
      runtime = await createDirectHarnessRuntime({ ...options, sessionPath, steeringMode: 'one-at-a-time' });
      const restartedFrames: Frame[] = [];
      runtime.onFrame((frame) => restartedFrames.push(frame));
      const restored = await request(runtime, restartedFrames, 'restored', 'get_entries');
      expect((restored.data as { entries: Frame[] }).entries.map((entry) => entry.id)).toEqual(ids);
      await expect(request(runtime, restartedFrames, 'restored-state', 'get_state')).resolves.toMatchObject({
        data: { sessionName: 'persistent name', steeringMode: 'one-at-a-time', followUpMode: 'all' },
      });
      await expect(
        request(runtime, restartedFrames, 'incremental', 'get_entries', { since: ids.at(-1) }),
      ).resolves.toMatchObject({ data: { entries: [] } });
      await runtime.prompt('continue after restart');
      const context = streamSimple.mock.calls.at(-1)?.[1];
      expect(JSON.stringify(context?.messages)).toContain('remember before restart');
      expect(JSON.stringify(context?.messages)).toContain('while disconnected');
      expect(JSON.stringify(context?.messages)).toContain('continue after restart');
    } finally {
      for (const client of clients) client.destroy();
      await served.close();
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('queues steer and follow-up input, aborts an active run, and accepts the next prompt', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'protocol-queue-test' }, BACKGROUND_CONTEXT);
    let callNumber = 0;
    const streamSimple = vi.fn<Models['streamSimple']>((...args: ModelCall) => {
      const [requestedModel, , options] = args;
      callNumber += 1;
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage(requestedModel, callNumber === 1 ? 'held' : 'recovered');
      stream.push({ type: 'start', partial: message });
      if (callNumber === 1) {
        const onAbort = () => {
          const aborted = assistantMessage(requestedModel, 'aborted', 'aborted');
          stream.push({ type: 'error', reason: 'aborted', error: aborted });
        };
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener('abort', onAbort, { once: true });
      } else {
        stream.push({ type: 'done', reason: 'stop', message });
      }
      return stream;
    });
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models: { ...models, streamSimple } as unknown as Models,
      model: modelA,
    });
    const frames: Frame[] = [];
    runtime.onFrame((frame) => frames.push(frame));

    try {
      runtime.send({ type: 'prompt', id: 'first-prompt', message: 'hold this run' });
      await waitForFrame(frames, (frame) => frame.type === 'message_start', 'provider start');

      await expect(request(runtime, frames, 'steer-queued', 'steer', { message: 'steer now' })).resolves.toMatchObject({
        command: 'steer',
        success: true,
      });
      await expect(
        request(runtime, frames, 'prompt-steer-queued', 'prompt', {
          message: 'steer through prompt',
          streamingBehavior: 'steer',
        }),
      ).resolves.toMatchObject({ command: 'prompt', success: true });
      await expect(
        request(runtime, frames, 'follow-up-queued', 'follow_up', { message: 'follow up later' }),
      ).resolves.toMatchObject({
        command: 'follow_up',
        success: true,
      });
      await expect(
        waitForFrame(
          frames,
          (frame) =>
            frame.type === 'queue_update' &&
            Array.isArray(frame.steering) &&
            frame.steering.includes('steer now') &&
            frame.steering.includes('steer through prompt') &&
            Array.isArray(frame.followUp) &&
            frame.followUp.includes('follow up later'),
          'queued input update',
        ),
      ).resolves.toBeDefined();

      await expect(request(runtime, frames, 'abort-active', 'abort')).resolves.toMatchObject({
        command: 'abort',
        success: true,
      });
      await expect(
        waitForFrame(frames, (frame) => frame.type === 'operation_abort', 'operation abort event'),
      ).resolves.toMatchObject({ steer: expect.any(Array), followUp: expect.any(Array) });
      await expect(
        request(runtime, frames, 'next-prompt', 'prompt', { message: 'run after abort' }),
      ).resolves.toMatchObject({
        command: 'prompt',
        success: true,
      });
      await expect(
        waitForFrame(frames, (frame) => frame.id === 'first-prompt', 'aborted prompt response'),
      ).resolves.toMatchObject({
        command: 'prompt',
        success: true,
      });
      expect(streamSimple).toHaveBeenCalledTimes(2);
      expect(streamSimple.mock.calls[1]?.[0]).toMatchObject({ provider: modelA.provider, id: modelA.id });
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('rejects an unknown model, recovers on the next request, and retains branched entries in memory', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'protocol-branch-test' }, BACKGROUND_CONTEXT);
    const streamSimple = vi.fn<Models['streamSimple']>((requestedModel) => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage(requestedModel, requestedModel.id);
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    });
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models: { ...models, streamSimple } as unknown as Models,
      model: modelA,
    });
    const frames: Frame[] = [];
    runtime.onFrame((frame) => frames.push(frame));

    try {
      await expect(
        request(runtime, frames, 'missing-model', 'set_model', { provider: 'missing', modelId: 'missing' }),
      ).resolves.toMatchObject({ command: 'set_model', success: false });
      await expect(
        request(runtime, frames, 'switch-model', 'set_model', {
          provider: modelB.provider,
          modelId: modelB.id,
        }),
      ).resolves.toMatchObject({ command: 'set_model', success: true, data: modelB });
      await expect(request(runtime, frames, 'state-after-switch', 'get_state')).resolves.toMatchObject({
        command: 'get_state',
        success: true,
        data: { model: { provider: modelB.provider, id: modelB.id } },
      });

      await expect(
        request(runtime, frames, 'first-branch-prompt', 'prompt', { message: 'first branch message' }),
      ).resolves.toMatchObject({
        command: 'prompt',
        success: true,
      });
      await expect(
        request(runtime, frames, 'second-branch-prompt', 'prompt', { message: 'second branch message' }),
      ).resolves.toMatchObject({
        command: 'prompt',
        success: true,
      });
      expect(streamSimple.mock.calls.map(([requestedModel]) => requestedModel.id)).toEqual(['model-b', 'model-b']);

      const entriesFrame = await request(runtime, frames, 'entries-before-branch', 'get_entries');
      const entries = (entriesFrame.data as { entries: Frame[] }).entries;
      const firstMessage = entries.find(
        (entry) => entry.type === 'message' && (entry.message as Frame)?.role === 'user',
      );
      expect(firstMessage?.id).toEqual(expect.any(String));

      await expect(
        request(runtime, frames, 'navigate-branch', 'navigate_tree', { targetId: firstMessage?.id }),
      ).resolves.toMatchObject({
        command: 'navigate_tree',
        success: true,
        data: { cancelled: false, entries: expect.any(Array) },
      });
      await expect(
        request(runtime, frames, 'branched-prompt', 'prompt', { message: 'branched message' }),
      ).resolves.toMatchObject({
        command: 'prompt',
        success: true,
      });
      await expect(request(runtime, frames, 'messages-after-branch', 'get_messages')).resolves.toMatchObject({
        command: 'get_messages',
        success: true,
        data: {
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'branched message' }] }),
          ]),
        },
      });
      const branchFrame = await request(runtime, frames, 'branch-parent', 'get_entries');
      const branchEntries = (branchFrame.data as { entries: Frame[] }).entries;
      const branchedUser = branchEntries.find(
        (entry) =>
          entry.type === 'message' &&
          (entry.message as Frame)?.role === 'user' &&
          JSON.stringify((entry.message as Frame).content).includes('branched message'),
      );
      expect(branchedUser?.parentId).toBe(firstMessage?.id);
      const providerContext = streamSimple.mock.calls.at(-1)?.[1];
      expect(JSON.stringify(providerContext?.messages)).toContain('first branch message');
      expect(JSON.stringify(providerContext?.messages)).toContain('branched message');
      expect(JSON.stringify(providerContext?.messages)).not.toContain('second branch message');
      expect(streamSimple.mock.calls.at(-1)?.[0]).toMatchObject({ provider: modelB.provider, id: modelB.id });
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
});
