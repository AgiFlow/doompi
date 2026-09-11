import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createHistoryOwnership,
  historyOwnershipLockPath,
} from '../../../../src/adapters/serialization/historyOwnership.ts';
import {
  createDirectHarnessRuntime,
  readDirectHarnessSessionMetadata,
} from '../../../../src/adapters/server/directHarnessRuntime.ts';

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

      await expect(runtime.readState()).resolves.toMatchObject({
        sessionId: 'direct-runtime-test',
        model: { provider: 'test-provider', id: 'test-model' },
      });
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
      await runtime.prompt('/known argument');
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
});
