import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LaneBusy } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import {
  JsonlSessionRepo,
  MemorySessionRepo,
  JSONL_STORAGE_VERSION,
} from '@earendil-works/pi-agent-core/harness/session';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { describe, expect, it, vi, type MockInstance } from 'vitest';

import { SessionMethodSchemas } from '../../../../../src/schemas/sessionApiContracts';
import {
  createDirectHarnessRuntime,
  promptForAssistantText,
  readDirectHarnessSessionMetadata,
} from '../../../../../src/server/directHarnessRuntime';
import { createHistoryOwnership, historyOwnershipLockPath } from '../../../../../src/services/historyOwnership';

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

describe('direct AgentHarness runtime', () => {
  it('returns only new assistant text from the prompt it just ran', async () => {
    const prior = {
      id: 'prior',
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
    };
    const user = {
      id: 'user',
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'question' }] },
    };
    const assistant = {
      id: 'answer',
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '  first ' }, { type: 'image' }, { type: 'text', text: 'second  ' }],
      },
    };
    const readEntries = vi
      .fn()
      .mockResolvedValueOnce({ entries: [prior] })
      .mockResolvedValueOnce({ entries: [prior, assistant, user] });
    const prompt = vi.fn(async () => undefined);
    expect(await promptForAssistantText({ readEntries, prompt } as never, 'ask')).toBe('first \nsecond');
    expect(prompt).toHaveBeenCalledWith('ask');
    readEntries.mockResolvedValueOnce({ entries: [prior] }).mockResolvedValueOnce({ entries: [prior, user] });
    expect(await promptForAssistantText({ readEntries, prompt } as never, 'again')).toBeUndefined();
    readEntries.mockResolvedValueOnce({ entries: [] }).mockResolvedValueOnce({
      entries: [{ ...assistant, message: { ...assistant.message, content: [{ type: 'text', text: '   ' }] } }],
    });
    expect(await promptForAssistantText({ readEntries, prompt } as never, 'blank')).toBeUndefined();
  });

  it('maps harness lifecycle, configuration, and queue events to presentation frames', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'event-frames-test' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    const frames: Record<string, unknown>[] = [];
    runtime.onPresentationFrame((frame) => frames.push(frame));
    const events = runtime.harness.events as unknown as {
      emit(event: Record<string, unknown>, context: typeof BACKGROUND_CONTEXT): Promise<void>;
    };
    try {
      for (const event of [
        { type: 'run_resume', runId: 'run' },
        { type: 'run_suspend', runId: 'run', reason: 'input', deferred: true },
        { type: 'operation_abort', operationId: 'operation', steer: 1, followUp: 2 },
        { type: 'retry_scheduled', runId: 'run', attempt: 2, maxAttempts: 3, errorMessage: 'retry' },
        { type: 'retry_start', runId: 'run', attempt: 2 },
        { type: 'retry_end', runId: 'run', attempt: 2, success: false, finalError: 'failed' },
        { type: 'tool_start', runId: 'run', turnId: 'turn', toolCallId: 'call', toolName: 'read', args: {} },
        { type: 'tool_update', runId: 'run', turnId: 'turn', toolCallId: 'call', toolName: 'read', partialResult: {} },
        {
          type: 'tool_end',
          runId: 'run',
          turnId: 'turn',
          toolCallId: 'call',
          toolName: 'read',
          result: {},
          isError: false,
        },
        { type: 'value_update', value: 'session_name', name: 'Renamed' },
        { type: 'value_update', value: 'label', targetId: 'entry', label: 'Reviewed' },
        { type: 'config_update', property: 'thinkingLevel', value: 'high' },
        { type: 'config_update', property: 'model', value: { provider: 'test', modelId: 'model' } },
        { type: 'config_update', property: 'model', value: null },
        { type: 'config_update', property: 'retry', value: true, previous: false },
        { type: 'compaction_start', runId: 'run', reason: 'manual' },
        { type: 'compaction_end', runId: 'run', reason: 'manual', status: 'completed' },
        { type: 'navigation_start', runId: 'run', targetId: 'entry' },
        { type: 'navigation_end', runId: 'run', status: 'completed' },
        { type: 'usage', lane: 'main', row: {}, totals: {} },
        { type: 'turn_start', runId: 'run', turnId: 'turn' },
        { type: 'turn_end', runId: 'run', turnId: 'turn', message: {}, toolResults: [] },
        { type: 'message_start', runId: 'run', message: {} },
        { type: 'message_update', runId: 'run', message: {}, event: {}, frame: { text: 'partial' } },
        { type: 'message_end', runId: 'run', message: {}, entryId: 'entry' },
        { type: 'entry_added', entry: { id: 'entry' } },
        { type: 'lane_created', at: 1 },
        { type: 'handler_error', kind: 'event', hook: 'before_run', event: 'run_start', error: 'broken' },
        {
          type: 'queue_update',
          queues: [
            null,
            { kind: 'steer', type: 'message', message: { content: 'steer' } },
            { kind: 'followUp', type: 'message', message: { content: [{ type: 'text', text: 'later' }] } },
            { kind: 'nextRun', type: 'message', message: { content: [{ type: 'text', text: 'next' }] } },
            { kind: 'unknown', type: 'message', message: { content: 'ignored' } },
          ],
        },
      ])
        await events.emit(event, BACKGROUND_CONTEXT);
      expect(frames.filter((frame) => frame.type !== 'lifecycle_update').map((frame) => frame.type)).toEqual([
        'agent_start',
        'run_suspend',
        'operation_abort',
        'auto_retry_start',
        'auto_retry_start',
        'auto_retry_end',
        'tool_execution_start',
        'tool_execution_update',
        'tool_execution_end',
        'session_info_changed',
        'entry_label_changed',
        'thinking_level_changed',
        'response',
        'config_update',
        'compaction_start',
        'compaction_end',
        'navigation_start',
        'navigation_end',
        'usage',
        'turn_start',
        'turn_end',
        'message_start',
        'message_update',
        'message_end',
        'entry_appended',
        'lane_created',
        'handler_error',
        'queue_update',
      ]);
      expect(frames).toContainEqual({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { model: { provider: 'test', id: 'model' } },
      });
      expect(frames).toContainEqual(
        expect.objectContaining({ type: 'tool_execution_end', toolCallId: 'call', isError: false }),
      );
      expect(frames).toContainEqual(
        expect.objectContaining({ type: 'queue_update', steering: ['steer'], followUp: ['later', 'next'] }),
      );
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('atomically excludes external tools from agent admissions and command dispatch', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'external-admission-test' }, BACKGROUND_CONTEXT);
    let releaseCommand: (() => void) | undefined;
    const commandPending = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const dispatchCommand = vi.fn(async () => {
      await commandPending;
      return true;
    });
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model, dispatchCommand });
    try {
      const command = runtime.submitPrompt('/known');
      await expect(runtime.runExternalOperation(async () => undefined)).rejects.toThrow('busy with an agent operation');
      releaseCommand?.();
      await expect(command).resolves.toMatchObject({ handledCommand: true });

      let releaseExternal: (() => void) | undefined;
      const externalPending = new Promise<void>((resolve) => {
        releaseExternal = resolve;
      });
      const external = runtime.runExternalOperation(() => externalPending);
      await Promise.resolve();

      await expect(runtime.submitPrompt('/blocked')).rejects.toThrow('busy with an external tool invocation');
      await expect(runtime.steer('blocked')).rejects.toThrow('busy with an external tool invocation');
      await expect(runtime.followUp('blocked')).rejects.toThrow('busy with an external tool invocation');
      await expect(runtime.nextRun('blocked')).rejects.toThrow('busy with an external tool invocation');
      expect(dispatchCommand).toHaveBeenCalledOnce();

      releaseExternal?.();
      await external;
      await expect(runtime.resume()).resolves.toBe(false);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('reports an idle lane as having nothing to resume instead of failing', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'resume-idle-test' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    try {
      // Every reopened session calls this, and most of them were idle. A throw
      // here would make the ordinary case indistinguishable from a real fault.
      expect(await runtime.resume()).toBe(false);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
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
  it('replaces resources through the public harness and exposes typed state', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'direct-runtime-test' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models,
      model,
    });

    try {
      expect(await runtime.readResources()).toEqual({});
      await runtime.replaceResources({ promptTemplates: [{ name: 'greet', content: 'Hello' }] });
      await expect(runtime.readResources()).resolves.toMatchObject({
        promptTemplates: [{ name: 'greet', content: 'Hello' }],
      });

      const state = await runtime.readState();
      expect(state).toMatchObject({
        sessionId: 'direct-runtime-test',
        model: { provider: 'test-provider', id: 'test-model' },
      });
      expect(state).not.toHaveProperty('operationId');
      expect(state).not.toHaveProperty('executionStatus');
      expect(Check(SessionMethodSchemas.getState.output, state)).toBe(true);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('exposes typed session operations without command frames', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'typed-runtime-test' }, BACKGROUND_CONTEXT);
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
    runtime.onPresentationFrame((frame) => frames.push(frame));
    try {
      expect(runtime.listCommands()).toEqual([{ name: 'known', description: 'Known command' }]);
      await expect(runtime.availableModels()).resolves.toEqual([model]);
      await expect(runtime.setModel({ provider: 'missing', id: 'missing' })).rejects.toThrow('Model not found');
      await runtime.setModel({ provider: model.provider, id: model.id });
      await runtime.setThinkingLevel('high');
      await runtime.setSteeringMode('one-at-a-time');
      await runtime.setFollowUpMode('all');
      await expect(runtime.appendCustomEntry('typed-test', { value: 1 })).resolves.toEqual(expect.any(String));
      await expect(
        runtime.recordUsage({
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }),
      ).resolves.toEqual(expect.any(String));
      await runtime.setName('Typed session');
      await expect(runtime.readState()).resolves.toMatchObject({ sessionName: 'Typed session', thinkingLevel: 'high' });
      await expect(runtime.readEntries()).resolves.toMatchObject({ entries: expect.any(Array) });
      await expect(runtime.clearQueue()).resolves.toEqual({ steering: [], followUp: [] });
      await runtime.prompt('normal prompt');
      expect(streamSimple).toHaveBeenCalledOnce();
      frames.length = 0;
      await runtime.prompt('/known argument');
      expect(dispatchCommand).toHaveBeenCalledWith('/known argument');
      await expect(runtime.dispatchCommand('/known argument')).resolves.toBe(true);
      await expect(runtime.dispatchCommand('/unknown argument')).resolves.toBe(false);
      expect(streamSimple).toHaveBeenCalledOnce();
      expect(frames).not.toContainEqual(expect.objectContaining({ type: 'agent_settled' }));
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
    try {
      await runtime.prompt('blocked');
      expect(streamSimple).not.toHaveBeenCalled();
      prepared = true;
      await runtime.prompt('recovered');
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
    try {
      await runtime.prompt('guarded');
      expect(streamSimple).not.toHaveBeenCalled();
      blocked = false;
      await runtime.prompt('allowed');
      expect(streamSimple).toHaveBeenCalledOnce();
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('surfaces typed command catalog failures and recovers for the next call', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'catalog-recovery-test' }, BACKGROUND_CONTEXT);
    const listCommands = vi
      .fn<() => []>()
      .mockImplementationOnce(() => {
        throw new Error('command catalog unavailable');
      })
      .mockReturnValue([]);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model, listCommands });
    try {
      expect(() => runtime.listCommands()).toThrow('command catalog unavailable');
      expect(runtime.listCommands()).toEqual([]);
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
    runtime.onPresentationFrame((frame) => frames.push(frame));
    let observerFailed = false;
    const unsubscribe = runtime.onEvent(async (event) => {
      if (event.type === 'run_start' && !observerFailed) {
        observerFailed = true;
        throw new Error('event observer failed');
      }
    });
    try {
      await runtime.prompt('event recovery');
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
      await runtime.dispose();
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
    const create = vi.spyOn(JsonlSessionRepo.prototype, 'create').mockImplementation(async function (
      this: JsonlSessionRepo,
      options,
      context,
    ) {
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
  it('validates upstream v4 session metadata before replaying a journal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-session-metadata-'));
    const validPath = path.join(root, 'valid.jsonl');
    const minimalPath = path.join(root, 'minimal.jsonl');
    fs.writeFileSync(
      validPath,
      `${JSON.stringify({
        kind: 'header',
        v: 4,
        id: 'session-id',
        cwd: root,
        createdAt: 123,
        parentSessionId: 'parent-id',
        legacyParentSessionPath: '/legacy/session.jsonl',
      })}\n`,
    );
    fs.writeFileSync(
      minimalPath,
      `${JSON.stringify({ kind: 'header', v: 4, id: 'minimal', cwd: root, createdAt: 456, storageVersion: 7 })}\n`,
    );
    try {
      expect(readDirectHarnessSessionMetadata(validPath)).toMatchObject({
        id: 'session-id',
        cwd: root,
        createdAt: 123,
        storageVersion: JSONL_STORAGE_VERSION,
        parentSessionId: 'parent-id',
        legacyParentSessionPath: '/legacy/session.jsonl',
        path: fs.realpathSync(validPath),
        modifiedAt: expect.any(Number),
      });
      expect(readDirectHarnessSessionMetadata(minimalPath)).toMatchObject({
        id: 'minimal',
        createdAt: 456,
        storageVersion: 7,
      });

      const invalidHeaders = [
        ['malformed', 'not-json', 'Invalid JSONL session header'],
        ['wrong-kind', JSON.stringify({ kind: 'session', v: 4 }), 'not an upstream v4 JSONL file'],
        ['wrong-version', JSON.stringify({ kind: 'header', v: 3 }), 'not an upstream v4 JSONL file'],
        [
          'invalid-identity',
          JSON.stringify({ kind: 'header', v: 4, id: '', cwd: root, createdAt: 1 }),
          'Invalid JSONL session identity',
        ],
        [
          'invalid-created-at',
          JSON.stringify({ kind: 'header', v: 4, id: 'session', cwd: root, createdAt: null }),
          'Invalid JSONL session identity',
        ],
      ] as const;
      for (const [name, content, message] of invalidHeaders) {
        const filePath = path.join(root, `${name}.jsonl`);
        fs.writeFileSync(filePath, `${content}\n`);
        expect(() => readDirectHarnessSessionMetadata(filePath)).toThrow(message);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines writes after a journal failure and reports the blocked state', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'quarantined-runtime' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    const frames: Record<string, unknown>[] = [];
    runtime.onPresentationFrame((frame) => frames.push(frame));
    const append = vi.spyOn(runtime.lane, 'appendCustomEntry').mockImplementation(async () => {
      throw new Error('journal write failed');
    });
    try {
      await expect(runtime.appendCustomEntry('will-fail')).rejects.toThrow('journal write failed');
      expect(runtime.storageQuarantined).toBe(true);
      expect(frames).toContainEqual({ type: 'error', code: 'storage_quarantined', error: 'journal write failed' });
      await expect(runtime.setName('blocked')).rejects.toThrow('writes are quarantined');
      expect(append).toHaveBeenCalledOnce();
    } finally {
      append.mockRestore();
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('returns a nonzero exit code when runtime cleanup fails and remains idempotent', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'cleanup-failure-runtime' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    vi.spyOn(runtime.harness, 'close').mockRejectedValue(new Error('harness cleanup failed'));
    try {
      await expect(runtime.dispose()).rejects.toThrow('harness cleanup failed');
      await expect(runtime.exited).resolves.toBe(1);
      await expect(runtime.dispose()).resolves.toBeUndefined();
    } finally {
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('refuses writable session creation without explicit history ownership', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-owner-required-'));
    try {
      await expect(
        createDirectHarnessRuntime({ cwd: root, sessionsRoot: root, sessionId: 'owner-required', models, model }),
      ).rejects.toThrow('requires explicit HistoryOwnership');
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an existing session when its identity does not match the requested id', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-session-mismatch-'));
    const sessionPath = path.join(root, 'session.jsonl');
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ kind: 'header', v: 4, id: 'actual-id', cwd: root, createdAt: 1 })}\n`,
    );
    const release = vi.fn();
    const ownership = { acquire: vi.fn(async () => ({ assertQuiescent: vi.fn(), release })) };
    try {
      await expect(
        createDirectHarnessRuntime({
          cwd: root,
          sessionPath,
          sessionId: 'requested-id',
          historyOwnership: ownership,
          models,
          model,
        }),
      ).rejects.toThrow('Session id mismatch: expected requested-id, found actual-id');
      expect(release).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails before harness creation when no public model registry or provider is configured', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'models-required' }, BACKGROUND_CONTEXT);
    try {
      await expect(createDirectHarnessRuntime({ cwd: '/tmp', session, model })).rejects.toThrow(
        'requires a public Models registry or at least one Provider',
      );
    } finally {
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('quarantines the runtime when session cleanup fails during disposal', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'session-cleanup-failure' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    vi.spyOn(session, 'close').mockRejectedValue(new Error('session close failed'));
    try {
      await expect(runtime.dispose()).rejects.toThrow('session close failed');
      expect(runtime.storageQuarantined).toBe(true);
      await expect(runtime.exited).resolves.toBe(1);
    } finally {
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('registers supplied providers on a registry that only exposes registerNativeProvider', async () => {
    const registered: unknown[] = [];
    const runtimeShaped = {
      getModels: () => [model],
      getModel: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      getAvailable: async () => [model],
      registerNativeProvider: (provider: unknown) => {
        registered.push(provider);
      },
    } as unknown as Models;
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'native-provider-merge' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models: runtimeShaped,
      providers: [{ id: 'anthropic-vertex' } as never],
      model,
    });
    try {
      expect(registered).toEqual([{ id: 'anthropic-vertex' }]);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('prefers setProvider over registerNativeProvider when the registry exposes both', async () => {
    const setProvider = vi.fn();
    const registerNativeProvider = vi.fn();
    const dualShaped = { ...models, setProvider, registerNativeProvider } as unknown as Models;
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'dual-provider-merge' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models: dualShaped,
      providers: [{ id: 'anthropic-vertex' } as never],
      model,
    });
    try {
      expect(setProvider).toHaveBeenCalledExactlyOnceWith({ id: 'anthropic-vertex' });
      expect(registerNativeProvider).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('rejects providers when the supplied registry cannot register any', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'provider-merge-unsupported' }, BACKGROUND_CONTEXT);
    try {
      await expect(
        createDirectHarnessRuntime({
          cwd: '/tmp',
          session,
          models,
          providers: [{ id: 'anthropic-vertex' } as never],
          model,
        }),
      ).rejects.toThrow('cannot register providers on the supplied Models registry');
    } finally {
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  // A streaming behaviour describes how to deliver into a turn that is already running. It must
  // still wake an idle lane, otherwise a headless caller can only talk to an agent that is busy.
  it('preserves automatic and held input through abort until explicit resume', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'paused-abort-queue' }, BACKGROUND_CONTEXT);
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let calls = 0;
    const streamSimple = vi.fn<Models['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
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
      if (++calls === 1) {
        firstStarted();
        void firstDone.then(() => stream.push({ type: 'done', reason: 'stop', message }));
      } else stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    });
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      model,
      models: { ...models, streamSimple } as unknown as Models,
    });
    try {
      const first = await runtime.submitPrompt('first');
      await started;
      await runtime.followUp('held voice');
      const { id } = await runtime.enqueueAutomatic('automatic after abort');
      const { id: removedId } = await runtime.enqueueAutomatic('remove before resume');
      expect(await runtime.removeQueued(removedId)).toBe('removed');
      const active = await runtime.readLifecycle();
      expect(active.operation?.status).toBe('open');
      expect(active.queue.map((item) => item.text)).toEqual(['held voice', 'automatic after abort']);
      await runtime.abort(active.operation!.id);
      await runtime.abort(active.operation!.id);
      await runtime.abort('old-operation');
      expect((await runtime.readLifecycle()).paused).toBe(true);
      releaseFirst();
      await first.settled.catch(() => undefined);
      expect((await runtime.readLifecycle()).queue.find((item) => item.id === id)?.disposition).toBe('pending');
      expect(streamSimple).toHaveBeenCalledTimes(1);
      await expect(runtime.submitPrompt('must not skip queued work')).rejects.toThrow('queue is paused');
      expect((await runtime.readLifecycle()).paused).toBe(true);
      await runtime.resumeQueue();
      await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => expect((await runtime.readLifecycle()).operation).toBeNull());
      expect((await runtime.readLifecycle()).queue.some((item) => item.id === id || item.id === removedId)).toBe(false);
      expect(streamSimple).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirst();
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('allows a prompt to resume an empty paused queue after reopening the runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-empty-paused-'));
    const environment = new NodeExecutionEnv({ cwd: root });
    const repository = new JsonlSessionRepo({ fileSystem: environment, sessionsRoot: root });
    const session = await repository.create({ id: 'empty-paused-abort', cwd: root }, BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);
    await repository.close(BACKGROUND_CONTEXT);
    await environment.cleanup(BACKGROUND_CONTEXT);
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let calls = 0;
    const streamSimple = vi.fn<Models['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
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
      if (++calls === 1) {
        firstStarted();
        void firstDone.then(() => stream.push({ type: 'done', reason: 'stop', message }));
      } else stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    });
    const options = {
      cwd: root,
      sessionsRoot: root,
      sessionId: 'empty-paused-abort',
      historyOwnership: createHistoryOwnership(),
      model,
      models: { ...models, streamSimple } as unknown as Models,
    };
    let runtime = await createDirectHarnessRuntime(options);
    try {
      const first = await runtime.submitPrompt('first');
      await started;
      const operationId = (await runtime.readLifecycle()).operation!.id;
      await runtime.abort(operationId);
      releaseFirst();
      await first.settled.catch(() => undefined);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: true, queue: [] });
      await runtime.dispose();
      runtime = await createDirectHarnessRuntime(options);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: true, queue: [] });
      const second = await runtime.submitPrompt('second');
      await second.settled;
      expect(streamSimple).toHaveBeenCalledTimes(2);
      expect(await runtime.readLifecycle()).toMatchObject({ paused: false, queue: [] });
    } finally {
      releaseFirst();
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('promotes one queued item into native steering without executing it as a separate turn', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'promote-native-steer' }, BACKGROUND_CONTEXT);
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let calls = 0;
    const streamSimple = vi.fn<Models['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
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
      if (++calls === 1) {
        firstStarted();
        void firstDone.then(() => stream.push({ type: 'done', reason: 'stop', message }));
      } else stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    });
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      model,
      models: { ...models, streamSimple } as unknown as Models,
    });
    try {
      const first = await runtime.submitPrompt('first');
      await started;
      const { id } = await runtime.enqueueAutomatic('change direction');
      const operationId = (await runtime.readLifecycle()).operation!.id;
      expect(await runtime.promoteQueued(id, operationId)).toBe('promoted');
      await vi.waitFor(async () =>
        expect((await runtime.readLifecycle()).queue.find((item) => item.id === id)?.disposition).toBe('handoff'),
      );
      releaseFirst();
      await first.settled;
      expect(streamSimple).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(streamSimple.mock.calls[1]?.[1].messages)).toContain('change direction');
      expect((await runtime.readLifecycle()).queue.some((item) => item.id === id)).toBe(false);
    } finally {
      releaseFirst();
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('wakes an idle lane and preserves delivery kind through a busy admission race', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'admit-streaming-behaviour' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    const inspectExecution = vi.spyOn(runtime.lane, 'inspectExecution');
    const accept = vi.spyOn(runtime.lane, 'accept');
    const drive = vi.spyOn(runtime.lane, 'drive');
    const steer = vi.spyOn(runtime.lane, 'steer');
    const followUp = vi.spyOn(runtime.lane, 'followUp');
    const busy = () =>
      new LaneBusy({ lane: 'main', operationId: 'op-live', operationKind: 'run', message: 'lane is busy' });
    try {
      steer.mockResolvedValue({ ok: true, value: { entryId: 'queued' } } as never);
      followUp.mockResolvedValue({ ok: true, value: { entryId: 'follow-up' } } as never);
      drive.mockResolvedValue({ ok: true, value: { kind: 'completed' } } as never);

      inspectExecution.mockResolvedValueOnce({ current: null } as never);
      accept.mockResolvedValueOnce({ ok: true, value: { operationId: 'op-1', kind: 'run', startedAt: 1 } } as never);
      const idle = await runtime.submitPrompt('wake up', undefined, 'steer');
      await expect(idle.settled).resolves.toBeUndefined();
      expect(accept).toHaveBeenCalledExactlyOnceWith({ kind: 'prompt', prompt: 'wake up' }, expect.anything());
      expect(drive).toHaveBeenCalledOnce();
      expect(steer).not.toHaveBeenCalled();

      inspectExecution.mockResolvedValueOnce({ current: { operationId: 'op-1' } } as never);
      const running = await runtime.submitPrompt('mid turn', undefined, 'steer');
      await expect(running.settled).resolves.toBeUndefined();
      expect(steer).toHaveBeenNthCalledWith(1, 'mid turn', undefined, expect.anything());
      expect(accept).toHaveBeenCalledOnce();
      expect(drive).toHaveBeenCalledOnce();

      // Another turn can start between inspection and admission; preserve the requested delivery kind.
      inspectExecution.mockResolvedValueOnce({ current: null } as never);
      accept.mockResolvedValueOnce({ ok: false, error: busy() } as never);
      const raced = await runtime.submitPrompt('raced', undefined, 'steer');
      await expect(raced.settled).resolves.toBeUndefined();
      expect(steer).toHaveBeenNthCalledWith(2, 'raced', undefined, expect.anything());
      expect(drive).toHaveBeenCalledOnce();

      inspectExecution.mockResolvedValueOnce({ current: null } as never);
      accept.mockResolvedValueOnce({ ok: false, error: busy() } as never);
      const followUpRace = await runtime.submitPrompt('later', undefined, 'followUp');
      await expect(followUpRace.settled).resolves.toBeUndefined();
      expect(followUp).toHaveBeenCalledExactlyOnceWith('later', undefined, expect.anything());

      // Without a streaming behaviour there is nowhere to put the text, so the busy lane still fails.
      inspectExecution.mockResolvedValueOnce({ current: null } as never);
      accept.mockResolvedValueOnce({ ok: false, error: busy() } as never);
      await expect(runtime.submitPrompt('plain')).rejects.toThrow('lane is busy');
      expect(steer).toHaveBeenCalledTimes(2);
    } finally {
      inspectExecution.mockRestore();
      accept.mockRestore();
      drive.mockRestore();
      steer.mockRestore();
      followUp.mockRestore();
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
});
