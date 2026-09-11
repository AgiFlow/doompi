import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { JsonlSessionRepo, MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createHistoryOwnership,
  historyOwnershipLockPath,
} from '../../../../src/adapters/serialization/historyOwnership.ts';
import { createDirectHarnessRuntime } from '../../../../src/adapters/server/directHarnessRuntime.ts';

const model: Model<Api> = {
  id: 'test-model',
  name: 'Test model',
  api: 'test-api',
  provider: 'test-provider',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65_536,
  maxTokens: 256,
};

const models = {
  getModels: () => [model],
  getModel: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
  getAvailable: async () => [model],
} as unknown as Models;

async function frameFor(frames: Record<string, unknown>[], id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = frames.find((candidate) => candidate.id === id);
    if (frame !== undefined) return frame;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for response ${id}`);
}

describe('direct AgentHarness runtime', () => {
  it.each(['sessionPath', 'legacySessionPath'] as const)(
    'rejects implicit v3 migration through %s without changing history',
    async (input) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-offline-startup-'));
      const sourcePath = path.join(root, 'legacy.jsonl');
      const source = `${JSON.stringify({ type: 'session', version: 3, id: 'legacy' })}\n`;
      fs.writeFileSync(sourcePath, source);
      try {
        await expect(
          createDirectHarnessRuntime({
            cwd: root,
            models,
            model,
            [input]: sourcePath,
            historyOwnership: createHistoryOwnership({ sourceFormat: 'v3' }),
          }),
        ).rejects.toThrow('doompi history-import <v3-source> <v4-destination> --confirm-offline');
        expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
        expect(fs.readdirSync(root)).toEqual(['legacy.jsonl']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each(['turn', 'request', 'late-tool-removal'] as const)(
    'blocks %s admission failure and recovers',
    async (phase) => {
      const repository = new MemorySessionRepo();
      const session = await repository.create({ id: `admission-${phase}` }, BACKGROUND_CONTEXT);
      const streamSimple = vi.fn<Models['streamSimple']>(() => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
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
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        return stream;
      });
      const tool = {
        name: 'allowed',
        label: 'Allowed',
        description: 'Allowed tool',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: undefined }),
      };
      let failing = true;
      const runtime = await createDirectHarnessRuntime({
        cwd: '/tmp',
        session,
        models: { ...models, streamSimple } as unknown as Models,
        model,
        tools: [tool],
        async beforeModelRequest(boundary) {
          if (failing && boundary.phase === phase) throw undefined;
          if (failing && phase === 'late-tool-removal' && boundary.phase === 'request') {
            await runtime.replaceTools([]);
          }
        },
      });
      try {
        await runtime.prompt('blocked').catch(() => undefined);
        expect(streamSimple).not.toHaveBeenCalled();
        failing = false;
        await runtime.replaceTools([tool]);
        await runtime.prompt('recovered');
        expect(streamSimple).toHaveBeenCalledOnce();
        expect(streamSimple.mock.calls[0]?.[1].tools?.map((entry) => entry.name)).toEqual(['allowed']);
        await runtime.replaceTools([]);
        await runtime.prompt('tools removed');
        expect(streamSimple).toHaveBeenCalledTimes(2);
        expect(streamSimple.mock.calls[1]?.[1].tools ?? []).toEqual([]);
      } finally {
        await runtime.dispose();
        await repository.close(BACKGROUND_CONTEXT);
      }
    },
  );

  it('replaces lane activation along with the tool registry without replacing the harness', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'tools-replacement' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    const harness = runtime.harness;
    try {
      await runtime.replaceTools([
        {
          name: 'allowed',
          label: 'Allowed',
          description: 'Allowed tool',
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: undefined }),
        },
      ]);
      await expect(runtime.lane.getActiveTools(BACKGROUND_CONTEXT)).resolves.toEqual(['allowed']);
      await runtime.replaceTools([]);
      await expect(runtime.lane.getActiveTools(BACKGROUND_CONTEXT)).resolves.toEqual([]);
      expect(runtime.harness).toBe(harness);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('replaces resources through the public harness and preserves framed state responses', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'direct-runtime-test' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models,
      model,
    });
    const frames: Record<string, unknown>[] = [];
    runtime.onFrame((frame) => frames.push(frame));

    try {
      expect(await runtime.readResources()).toEqual({});
      await runtime.replaceResources({ promptTemplates: [{ name: 'greet', content: 'Hello' }] });
      await expect(runtime.readResources()).resolves.toMatchObject({
        promptTemplates: [{ name: 'greet', content: 'Hello' }],
      });

      runtime.send({ type: 'get_state', id: 'state' });
      await expect(frameFor(frames, 'state')).resolves.toMatchObject({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId: 'direct-runtime-test', model: { provider: 'test-provider', id: 'test-model' } },
      });
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('serves protocol command variants and reports rejected operations as responses', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'protocol-runtime-test' }, BACKGROUND_CONTEXT);
    const streamSimple = vi.fn<Models['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'provider response' }],
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
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    });
    const dispatchCommand = vi.fn(async (text: string) => text.startsWith('/known'));
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models: { ...models, streamSimple } as unknown as Models,
      model,
      listCommands: () => [{ name: 'known', description: 'Known command' }],
      dispatchCommand,
    });
    const frames: Record<string, unknown>[] = [];
    runtime.onFrame((frame) => frames.push(frame));
    let requestId = 0;
    const request = async (type: string, fields: Record<string, unknown> = {}) => {
      const id = `protocol-${++requestId}`;
      runtime.send({ type, id, ...fields });
      return frameFor(frames, id);
    };

    try {
      await expect(request('get_commands')).resolves.toMatchObject({
        type: 'response',
        command: 'get_commands',
        success: true,
        data: { commands: [{ name: 'known', description: 'Known command', source: 'extension' }] },
      });
      await expect(request('get_available_models')).resolves.toMatchObject({
        command: 'get_available_models',
        success: true,
        data: { models: [model] },
      });
      await expect(request('set_model', { provider: model.provider, modelId: model.id })).resolves.toMatchObject({
        command: 'set_model',
        success: true,
        data: model,
      });
      await expect(request('set_model', { provider: 'missing', modelId: 'missing' })).resolves.toMatchObject({
        command: 'set_model',
        success: false,
      });
      await expect(request('set_thinking_level', { level: 'high' })).resolves.toMatchObject({
        command: 'set_thinking_level',
        success: true,
      });
      await expect(request('set_thinking_level')).resolves.toMatchObject({
        command: 'set_thinking_level',
        success: false,
      });
      await expect(request('set_steering_mode', { mode: 'one-at-a-time' })).resolves.toMatchObject({ success: true });
      await expect(request('set_follow_up_mode', { mode: 'all' })).resolves.toMatchObject({ success: true });
      await expect(request('set_follow_up_mode', { mode: 'invalid' })).resolves.toMatchObject({ success: false });
      await expect(
        request('append_custom_entry', { customType: 'protocol-test', data: { value: 1 } }),
      ).resolves.toMatchObject({
        command: 'append_custom_entry',
        success: true,
        data: { entryId: expect.any(String) },
      });
      await expect(request('append_custom_entry')).resolves.toMatchObject({ success: false });
      await expect(
        request('record_usage', {
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      ).resolves.toMatchObject({
        command: 'record_usage',
        success: true,
        data: { usageId: expect.any(String) },
      });
      await expect(request('record_usage')).resolves.toMatchObject({ success: false });
      await expect(request('get_entries')).resolves.toMatchObject({
        command: 'get_entries',
        success: true,
        data: { entries: expect.any(Array), leafId: expect.any(String) },
      });
      await expect(request('get_entries', { since: 'missing-entry' })).resolves.toMatchObject({
        command: 'get_entries',
        success: false,
      });
      await expect(request('get_messages')).resolves.toMatchObject({
        command: 'get_messages',
        success: true,
        data: { messages: [] },
      });
      await expect(request('set_session_name', { name: 'Protocol session' })).resolves.toMatchObject({ success: true });
      await expect(request('set_session_name', { name: '   ' })).resolves.toMatchObject({ success: false });
      await expect(request('get_state')).resolves.toMatchObject({
        command: 'get_state',
        success: true,
        data: { sessionId: 'protocol-runtime-test', sessionName: 'Protocol session', thinkingLevel: 'high' },
      });
      await expect(request('clear_queue')).resolves.toMatchObject({
        command: 'clear_queue',
        success: true,
        data: { steering: [], followUp: [] },
      });
      await expect(request('prompt', { message: 42 })).resolves.toMatchObject({
        command: 'prompt',
        success: false,
      });
      runtime.send({ type: 'prompt', id: 'normal-prompt', message: 'normal prompt' });
      await expect(frameFor(frames, 'normal-prompt')).resolves.toMatchObject({ command: 'prompt', success: true });
      expect(streamSimple).toHaveBeenCalledOnce();
      await expect(request('steer', { message: 'steer this' })).resolves.toMatchObject({
        command: 'steer',
        success: true,
      });
      await expect(request('follow_up', { message: 'follow this' })).resolves.toMatchObject({
        command: 'follow_up',
        success: true,
      });
      await expect(request('steer')).resolves.toMatchObject({ command: 'steer', success: false });
      await expect(request('abort')).resolves.toMatchObject({ command: 'abort', success: expect.any(Boolean) });
      await expect(request('compact', { customInstructions: 'Keep protocol history concise' })).resolves.toMatchObject({
        command: 'compact',
        success: expect.any(Boolean),
      });
      await expect(request('resume')).resolves.toMatchObject({ command: 'resume', success: expect.any(Boolean) });
      await expect(request('navigate_tree', { targetId: 42 })).resolves.toMatchObject({
        command: 'navigate_tree',
        success: false,
      });
      runtime.send({ id: 'missing-type' });
      await expect(frameFor(frames, 'missing-type')).resolves.toMatchObject({
        command: 'unknown',
        success: false,
      });
      await expect(request('navigate_tree', { targetId: null })).resolves.toMatchObject({
        command: 'navigate_tree',
        success: expect.any(Boolean),
      });
      await expect(request('unknown_protocol_command')).resolves.toMatchObject({
        command: 'unknown_protocol_command',
        success: false,
      });
      runtime.send({ type: 'prompt', id: 'slash-prompt', message: '/known argument' });
      await expect(frameFor(frames, 'slash-prompt')).resolves.toMatchObject({ command: 'prompt', success: true });
      expect(dispatchCommand).toHaveBeenCalledWith('/known argument');
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('emits a rejected prompt response without dispatching the provider, then recovers', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'admission-protocol-test' }, BACKGROUND_CONTEXT);
    const streamSimple = vi.fn<Models['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered' }],
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
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    });
    let prepared = false;
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models: { ...models, streamSimple } as unknown as Models,
      model,
      beforeModelRequest: async ({ phase }) => {
        if (phase === 'turn' && !prepared) throw new Error('capability preparation failed');
      },
    });
    const frames: Record<string, unknown>[] = [];
    runtime.onFrame((frame) => frames.push(frame));
    try {
      runtime.send({ type: 'prompt', id: 'blocked-prompt', message: 'blocked' });
      await expect(frameFor(frames, 'blocked-prompt')).resolves.toMatchObject({
        type: 'response',
        command: 'prompt',
        success: true,
      });
      expect(streamSimple).not.toHaveBeenCalled();
      prepared = true;
      runtime.send({ type: 'prompt', id: 'recovered-prompt', message: 'recovered' });
      await expect(frameFor(frames, 'recovered-prompt')).resolves.toMatchObject({
        command: 'prompt',
        success: true,
      });
      expect(streamSimple).toHaveBeenCalledOnce();
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('keeps the model admission guard outside provider dispatch', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'guard-protocol-test' }, BACKGROUND_CONTEXT);
    const streamSimple = vi.fn<Models['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
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
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    });
    let blocked = true;
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models: { ...models, streamSimple } as unknown as Models,
      model,
      guardModelRequest: () => {
        if (blocked) throw new Error('provider admission blocked');
      },
    });
    const frames: Record<string, unknown>[] = [];
    runtime.onFrame((frame) => frames.push(frame));
    try {
      runtime.send({ type: 'prompt', id: 'guarded-prompt', message: 'guarded' });
      await expect(frameFor(frames, 'guarded-prompt')).resolves.toMatchObject({ success: true });
      expect(streamSimple).not.toHaveBeenCalled();
      blocked = false;
      runtime.send({ type: 'prompt', id: 'allowed-prompt', message: 'allowed' });
      await expect(frameFor(frames, 'allowed-prompt')).resolves.toMatchObject({ success: true });
      expect(streamSimple).toHaveBeenCalledOnce();
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('frames command-provider failures and recovers for the next request', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'frame-recovery-test' }, BACKGROUND_CONTEXT);
    const listCommands = vi
      .fn<() => []>()
      .mockImplementationOnce(() => {
        throw new Error('command catalog unavailable');
      })
      .mockReturnValue([]);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model, listCommands });
    const frames: Record<string, unknown>[] = [];
    runtime.onFrame((frame) => frames.push(frame));
    try {
      runtime.send({ id: 'unexpected-command', type: 'get_commands' });
      await expect(frameFor(frames, 'unexpected-command')).resolves.toMatchObject({
        type: 'response',
        command: 'get_commands',
        success: false,
        error: 'command catalog unavailable',
      });
      runtime.send({ type: 'get_commands', id: 'recovered-command' });
      await expect(frameFor(frames, 'recovered-command')).resolves.toMatchObject({
        type: 'response',
        command: 'get_commands',
        success: true,
        data: { commands: [] },
      });
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('frames lifecycle observer failures and supports end-of-input shutdown', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'event-recovery-test' }, BACKGROUND_CONTEXT);
    const streamSimple = vi.fn<Models['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'event recovery' }],
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
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    });
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models: { ...models, streamSimple } as unknown as Models,
      model,
    });
    const frames: Record<string, unknown>[] = [];
    runtime.onFrame((frame) => frames.push(frame));
    let observerFailed = false;
    const unsubscribe = runtime.onEvent(async (event) => {
      if (event.type === 'run_start' && !observerFailed) {
        observerFailed = true;
        throw new Error('event observer failed');
      }
    });
    try {
      runtime.send({ type: 'prompt', id: 'event-prompt', message: 'event recovery' });
      await expect(frameFor(frames, 'event-prompt')).resolves.toMatchObject({ command: 'prompt', success: true });
      expect(observerFailed).toBe(true);
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: 'handler_error',
          kind: 'event',
          event: 'run_start',
          error: 'event observer failed',
        }),
      );
      unsubscribe();
      runtime.endInput();
      await expect(runtime.exited).resolves.toBe(0);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('stops an idle runtime and settles its exit promise', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'stop-runtime-test' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      runtime.stop();
      await expect(runtime.exited).resolves.toBe(0);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('closes a created session and releases its lease when harness setup fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-direct-runtime-failure-'));
    const owner = createHistoryOwnership();
    let destination = '';
    const acquire = vi.fn(async (filePath: string) => {
      destination = filePath;
      return owner.acquire(filePath);
    });
    const originalCreate = JsonlSessionRepo.prototype.create;
    let createdClose: MockInstance<Awaited<ReturnType<JsonlSessionRepo['create']>>['close']> | undefined;
    const create = vi
      .spyOn(JsonlSessionRepo.prototype, 'create')
      .mockImplementation(async function (this: JsonlSessionRepo, options, context) {
        const created = await originalCreate.call(this, options, context);
        createdClose = vi.spyOn(created, 'close');
        return created;
      });
    try {
      await expect(
        createDirectHarnessRuntime({
          cwd: root,
          sessionsRoot: root,
          sessionId: 'failed-runtime-creation',
          historyOwnership: { acquire },
          models,
          model: { provider: 'missing', id: 'missing' },
        }),
      ).rejects.toThrow('Direct harness could not resolve missing/missing');
      expect(acquire).toHaveBeenCalledOnce();
      expect(createdClose?.mock.calls).toHaveLength(1);
      expect(destination).not.toBe('');
      expect(fs.existsSync(historyOwnershipLockPath(destination))).toBe(false);
      const reopened = await owner.acquire(destination);
      await reopened.release();
    } finally {
      create.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reopens an existing workspace session when a supervised restart supplies its id', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-direct-runtime-restart-'));
    const environment = new NodeExecutionEnv({ cwd: root });
    const repository = new JsonlSessionRepo({ fileSystem: environment, sessionsRoot: root });
    const source = await repository.create({ id: 'restart-runtime-test', cwd: root }, BACKGROUND_CONTEXT);
    const sessionPath = source.metadata.path;
    await source.close(BACKGROUND_CONTEXT);
    await repository.close(BACKGROUND_CONTEXT);
    await environment.cleanup(BACKGROUND_CONTEXT);

    const runtime = await createDirectHarnessRuntime({
      cwd: root,
      sessionsRoot: root,
      sessionId: 'restart-runtime-test',
      historyOwnership: createHistoryOwnership(),
      models,
      model,
    });

    try {
      expect(runtime.sessionId).toBe('restart-runtime-test');
      expect(fs.existsSync(sessionPath)).toBe(true);
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires and retains an exclusive lease for an existing v4 session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-direct-runtime-'));
    const environment = new NodeExecutionEnv({ cwd: root });
    const repository = new JsonlSessionRepo({ fileSystem: environment, sessionsRoot: root });
    const source = await repository.create({ id: 'leased-runtime-test', cwd: root }, BACKGROUND_CONTEXT);
    const sessionPath = source.metadata.path;
    await source.close(BACKGROUND_CONTEXT);
    await repository.close(BACKGROUND_CONTEXT);
    await environment.cleanup(BACKGROUND_CONTEXT);

    const release = vi.fn();
    const assertQuiescent = vi.fn();
    const acquire = vi.fn(async () => ({ assertQuiescent, release }));
    const runtime = await createDirectHarnessRuntime({
      cwd: root,
      sessionPath,
      historyOwnership: { acquire },
      models,
      model,
    });

    try {
      expect(acquire).toHaveBeenCalledWith(sessionPath);
      expect(assertQuiescent).toHaveBeenCalled();
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(release).toHaveBeenCalledOnce();
  });
});
