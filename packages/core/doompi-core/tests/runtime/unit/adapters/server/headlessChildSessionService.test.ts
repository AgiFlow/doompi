import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AgentDoc } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DoomChildSessionRequest } from '../../../../../src/exports/childSession';
import type { DirectHarnessRuntime, DirectHarnessRuntimeOptions } from '../../../../../src/server/directHarnessRuntime';
import { DurableNavigationDoc } from '../../../../../src/services/durableNavigation';
import { createHistoryOwnership } from '../../../../../src/services/historyOwnership';
import { openSqliteSessionStorage, SessionMetadataDoc } from '../../../../../src/services/sqliteSessionStorage';
import {
  composeDirectHarnessRequestOptions,
  bindChildMcpCatalog,
  createHeadlessChildSessionService,
  createHeadlessChildSessionServiceProvider,
  type HeadlessChildSessionServiceOptions,
} from '../../../../../src/systems/child/adapters/headlessChildSessionService';

function request(source: DoomChildSessionRequest['source'], cwd = '/tmp'): DoomChildSessionRequest {
  return {
    runId: `run-${Math.random()}`,
    parentSessionId: 'parent-session',
    scope: { rootSessionId: 'parent-session', scopeKey: 'test' },
    source,
    agent: 'writer',
    task: 'do the thing',
    cwd,
    environment: {},
  };
}

function fakeRuntime(sessionId: string, filePath?: string): DirectHarnessRuntime {
  return {
    sessionId,
    sessionFile: filePath,
    laneName: 'main',
    harnessId: sessionId,
    session: { metadata: { path: filePath } } as unknown as DirectHarnessRuntime['session'],
    harness: {} as DirectHarnessRuntime['harness'],
    lane: {} as DirectHarnessRuntime['lane'],
    exited: Promise.resolve(0),
    storageQuarantined: false,
    onPresentationFrame: () => () => undefined,
    onEvent: () => () => undefined,
    stop: () => undefined,
    readState: async () => ({}),
    readLifecycle: async () => ({ revision: 0, operation: null, paused: false, queue: [] }),
    enqueueAutomatic: async () => ({ id: 'queued' }),
    removeQueued: async () => 'not_found',
    promoteQueued: async () => 'not_found',
    resumeQueue: async () => undefined,
    recover: async () => undefined,
    readEntries: async () => ({ entries: [], leafId: null }),
    listCommands: () => [],
    dispatchCommand: async () => false,
    setFastMode: async () => undefined,
    setModel: async () => undefined,
    availableModels: async () => [],
    availableThinkingLevels: async () => [],
    setThinkingLevel: async () => undefined,
    setSteeringMode: async () => undefined,
    setFollowUpMode: async () => undefined,
    navigateTree: async () => ({ cancelled: false, entries: [] }),
    clearQueue: async () => ({ steering: [], followUp: [] }),
    setName: async () => undefined,
    getSessionStats: async () => ({}) as never,
    replaceTools: async () => undefined,
    replaceResources: async () => undefined,
    readResources: async () => ({}),
    runExternalOperation: (operation) => operation(),
    appendCustomEntry: async () => 'entry',
    appendMessage: async () => 'entry',
    setLabel: async () => undefined,
    recordUsage: async () => 'usage',
    submitPrompt: vi.fn(async () => ({ settled: Promise.resolve() })),
    submitUserPrompt: vi.fn(async () => ({ settled: Promise.resolve() })),
    submitInternalMessage: vi.fn(async () => ({ settled: Promise.resolve() })),
    admitMessage: vi.fn(async () => ({ settled: Promise.resolve() })),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    nextRun: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    admitResume: vi.fn(async () => ({ resumed: false, settled: Promise.resolve() })),
    resume: vi.fn(async () => false),
    dispose: vi.fn(async () => undefined),
  };
}

function runtimeFactory(runtime: DirectHarnessRuntime) {
  return vi.fn(async (_options: DirectHarnessRuntimeOptions) => runtime);
}

async function createSource(
  root: string,
  whileOpen?: (opened: Awaited<ReturnType<typeof openSqliteSessionStorage>>) => Promise<void>,
): Promise<string> {
  const opened = await openSqliteSessionStorage(
    { sessionId: 'source', sessionsRoot: root, historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }) },
    BACKGROUND_CONTEXT,
  );
  await opened.session.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    await tx.appendEntry(conversation.id, {
      kind: 'pi.user',
      model: [{ role: 'user', content: 'source', timestamp: Date.now() }],
    });
    Object.assign(await tx.doc(AgentDoc, conversation.id), {
      model: { provider: 'test', modelId: 'test' },
      thinkingLevel: 'off',
      tools: [],
    });
    (await tx.doc(DurableNavigationDoc)).activeConversationId = conversation.id;
  }, BACKGROUND_CONTEXT);
  try {
    await whileOpen?.(opened);
  } finally {
    await opened.session.close(BACKGROUND_CONTEXT);
    await opened.historyLease.release();
  }
  return opened.sessionFile;
}

describe('headless child session provider', () => {
  it('emits only the selected work MCP declaration in an actual native child model request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-child-model-tools-'));
    const model: Model<Api> = {
      id: 'test-model',
      name: 'Test',
      provider: 'test-provider',
      api: 'test-api',
      baseUrl: 'http://localhost',
      reasoning: false,
      input: ['text'],
      contextWindow: 65536,
      maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const parameters = Type.Object(
      {
        query: Type.String({ minLength: 1 }),
        filters: Type.Optional(Type.Object({ tags: Type.Array(Type.String()) })),
      },
      { additionalProperties: false },
    );
    const tools = ['personal', 'work'].map((server) => ({
      name: `${server}_search`,
      description: `Search ${server} account`,
      parameters,
      execute: async () => ({ content: [] }),
    }));
    const streamSimple = vi.fn<ModelRuntime['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Done' }],
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
      stream.end();
      return stream;
    });
    const models = {
      getModel: () => model,
      getModels: () => [model],
      getAvailable: async () => [model],
      hasConfiguredAuth: () => true,
      streamSimple,
    } as unknown as ModelRuntime;
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent',
      cwd: root,
      sessionsRoot: root,
      models,
      defaultModel: () => ({ provider: model.provider, id: model.id }),
      mcpTool: () => ({
        name: 'mcp',
        description: 'Private dispatcher',
        parameters: {},
        execute: async () => ({ content: [] }),
        catalog: { snapshot: () => tools, resolveSelectors: () => ['work_search'], subscribe: () => () => undefined },
      }),
    });
    try {
      const child = await service.start({
        ...request({ kind: 'fresh' }, root),
        tools: ['mcp_use'],
        mcpDirectTools: ['work/search'],
        capabilityCeiling: { allowedTools: ['mcp'], allowMcpTools: true },
      });
      await vi.waitFor(() => expect(child.state()).toBe('completed'));
      expect(streamSimple).toHaveBeenCalledOnce();
      // Pi 1.0 carries declarations as transcript tool deltas, not context.tools.
      const emitted = streamSimple.mock.calls[0]![1].messages.flatMap((message) =>
        'toolsAdded' in message ? (message.toolsAdded ?? []) : [],
      );
      expect(emitted.map(({ name }) => name)).toEqual(['work_search']);
      expect(emitted.map(({ name, description, parameters }) => ({ name, description, parameters }))).toEqual([
        { name: 'work_search', description: 'Search work account', parameters },
      ]);
      await child.dispose();
    } finally {
      await service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  beforeEach(() => vi.restoreAllMocks());

  it('forks a live parent with pending WAL without checkpointing or closing its writer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-child-live-fork-'));
    const factory = runtimeFactory(fakeRuntime('live-child'));
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent',
      cwd: root,
      runtimeFactory: factory,
    });
    try {
      await createSource(root, async (parent) => {
        const wal = fs.readFileSync(`${parent.sessionFile}-wal`);
        expect(wal.length).toBeGreaterThan(0);
        const child = await service.start(
          request({ kind: 'v4-fork', sessionFile: parent.sessionFile, branch: 'main' }, root),
        );
        expect(factory.mock.calls[0]?.[0].sessionPath).not.toBe(parent.sessionFile);
        expect(fs.readFileSync(`${parent.sessionFile}-wal`)).toEqual(wal);
        await parent.session.commit(async (tx) => {
          (await tx.doc(SessionMetadataDoc)).name = 'still writable';
        }, BACKGROUND_CONTEXT);
        await child.dispose();
      });
    } finally {
      await service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])('snapshots parent Fast %s for fresh, restored, and forked children', async (enabled) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-child-fast-'));
    const source = await createSource(root);
    let parentMode = enabled;
    const snapshots: Array<boolean | undefined> = [];
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: root,
      parentFastMode: () => parentMode,
      runtimeFactory: async (options) => {
        parentMode = !parentMode;
        snapshots.push(options.initialFastMode);
        return fakeRuntime(`child-${snapshots.length}`);
      },
    });
    try {
      for (const sourceRequest of [
        { kind: 'fresh' },
        { kind: 'v4-restore', sessionFile: source },
        { kind: 'v4-fork', sessionFile: source, branch: 'main' },
      ] as DoomChildSessionRequest['source'][]) {
        parentMode = enabled;
        const child = await service.start(request(sourceRequest, root));
        expect(snapshots.at(-1)).toBe(enabled);
        parentMode = !enabled;
        expect(snapshots.at(-1)).toBe(enabled);
        await child.dispose();
      }
    } finally {
      await service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-boolean parent preference before child creation', async () => {
    const factory = runtimeFactory(fakeRuntime('invalid'));
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: '/tmp',
      parentFastMode: (() => 'true') as unknown as () => boolean,
      runtimeFactory: factory,
    });
    await expect(service.start(request({ kind: 'fresh' }))).rejects.toThrow('must be a boolean');
    expect(factory).not.toHaveBeenCalled();
    await service.close();
  });

  it('creates a fresh child with a new session identity and disposes it once', async () => {
    const runtime = fakeRuntime('fresh-child');
    const factory = runtimeFactory(runtime);
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: '/tmp',
      runtimeFactory: factory,
    });

    const handle = await service.start(request({ kind: 'fresh' }));

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'parent-session',
        cwd: '/tmp',
        sessionId: expect.any(String),
      }),
    );
    expect(factory.mock.calls[0]?.[0]).not.toHaveProperty('sessionPath');
    await handle.dispose();
    await handle.dispose();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('forwards committed runtime usage into the child lifecycle cost', async () => {
    const listeners = new Set<Parameters<DirectHarnessRuntime['onEvent']>[0]>();
    const onEvent = vi.fn((listener: Parameters<DirectHarnessRuntime['onEvent']>[0]) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const runtime = { ...fakeRuntime('usage-child'), onEvent } as DirectHarnessRuntime;
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: '/tmp',
      runtimeFactory: runtimeFactory(runtime),
    });
    const handle = await service.start(request({ kind: 'fresh' }));
    const events: Array<{ state: string; cost?: number }> = [];
    handle.subscribe((event) => events.push(event));

    for (const listener of listeners) {
      void listener(
        {
          type: 'usage',
          lane: 'main',
          row: { id: 'usage-1', usage: { cost: { total: 1.25 } } },
          totals: {},
        } as never,
        {} as never,
      );
    }

    expect(onEvent).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ state: 'running', cost: 1.25 });
    await handle.dispose();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('publishes the final assistant text in the completion event', async () => {
    const base = fakeRuntime('summary-child');
    const readEntries = vi
      .fn<DirectHarnessRuntime['readEntries']>()
      .mockResolvedValueOnce({ entries: [{ id: 'parent' }], leafId: 'parent' } as never)
      .mockResolvedValue({
        entries: [
          { id: 'parent' },
          {
            id: 'child',
            type: 'message',
            message: { role: 'assistant', content: [{ type: 'text', text: 'child summary' }] },
          },
        ],
        leafId: 'child',
      } as never);
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: '/tmp',
      runtimeFactory: runtimeFactory({ ...base, readEntries } as DirectHarnessRuntime),
    });
    const handle = await service.start(request({ kind: 'fresh' }));
    const events: Array<{ state: string; message?: string }> = [];
    handle.subscribe((event) => events.push(event));

    await vi.waitFor(() => expect(handle.state()).toBe('completed'));

    expect(events.at(-1)).toMatchObject({ state: 'completed', message: 'child summary' });
  });

  it('accepts SQLite restore sources and rejects JSONL before runtime creation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-child-restore-'));
    const v4Path = await createSource(root);
    const v3Path = path.join(root, 'legacy.jsonl');
    fs.writeFileSync(v3Path, '{"type":"session","version":3}\n');
    const runtime = fakeRuntime('restored-child', v4Path);
    const factory = runtimeFactory(runtime);
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: root,
      runtimeFactory: factory,
    });

    const handle = await service.start(request({ kind: 'v4-restore', sessionFile: v4Path }, root));
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPath: path.resolve(v4Path), storage: 'sqlite' }),
    );
    await handle.dispose();

    await expect(service.start(request({ kind: 'v4-restore', sessionFile: v3Path }))).rejects.toThrow('SQLite');
    expect(factory).toHaveBeenCalledOnce();
  });

  it('forks a v4 branch into a separate destination and releases fork ownership once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-child-fork-'));
    const sourcePath = await createSource(root);
    const runtime = fakeRuntime('forked-child');
    const factory = runtimeFactory(runtime);
    const sourceRelease = vi.fn();
    const destinationRelease = vi.fn();
    const sourceLease = { assertQuiescent: vi.fn(), release: sourceRelease };
    const destinationLease = { assertQuiescent: vi.fn(), release: destinationRelease };
    const ownership = {
      acquire: vi.fn(async (ownedPath: string) =>
        ownedPath === fs.realpathSync(sourcePath) ? sourceLease : destinationLease,
      ),
    };
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: root,
      runtimeFactory: factory,
      historyOwnership: ownership,
    });

    const handle = await service.start(request({ kind: 'v4-fork', sessionFile: sourcePath, branch: 'main' }, root));
    const destinationPath = factory.mock.calls[0]?.[0].sessionPath;

    expect(destinationPath).toEqual(expect.any(String));
    expect(destinationPath).not.toBe(sourcePath);
    expect(fs.existsSync(destinationPath!)).toBe(true);
    expect(fs.readFileSync(destinationPath!).subarray(0, 16).toString()).toBe('SQLite format 3\u0000');
    expect(ownership.acquire).toHaveBeenCalledOnce();
    expect(ownership.acquire).not.toHaveBeenCalledWith(fs.realpathSync(sourcePath));
    expect(sourceLease.assertQuiescent).not.toHaveBeenCalled();
    expect(destinationLease.assertQuiescent).toHaveBeenCalledOnce();
    expect(sourceRelease).not.toHaveBeenCalled();
    expect(destinationRelease).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[0].historyOwnership).toBe(ownership);

    await handle.dispose();
    await service.close();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(sourceRelease).not.toHaveBeenCalled();
    expect(destinationRelease).toHaveBeenCalledOnce();
  });

  it('installs and disposes an injected direct intercom tool with the child runtime', async () => {
    const replaceTools = vi.fn(async (_tools: Parameters<DirectHarnessRuntime['replaceTools']>[0]) => undefined);
    const runtime = { ...fakeRuntime('intercom-child'), replaceTools } as DirectHarnessRuntime;
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const intercom = {
      bindRuntime: vi.fn(() => ({ name: 'intercom', description: 'direct', parameters: {}, execute })),
      dispose: vi.fn(),
    };
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: '/tmp',
      runtimeFactory: runtimeFactory(runtime),
    });

    const handle = await service.start({ ...request({ kind: 'fresh' }), intercom });
    expect(intercom.bindRuntime).toHaveBeenCalledOnce();
    expect(replaceTools).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: 'intercom' })]));
    const installed = replaceTools.mock.calls[0]?.[0].find((tool) => tool.name === 'intercom');
    await (installed!.execute as (...args: unknown[]) => Promise<unknown>)(
      'operation',
      { action: 'members' },
      () => undefined,
      undefined,
      {},
      BACKGROUND_CONTEXT,
    );
    expect(execute).toHaveBeenCalledWith(
      'operation',
      { action: 'members' },
      expect.any(AbortSignal),
      expect.any(Function),
    );

    await handle.dispose();
    await handle.dispose();
    expect(intercom.dispose).toHaveBeenCalledOnce();
  });

  it('disposes the runtime and direct intercom when tool installation fails', async () => {
    const runtime = {
      ...fakeRuntime('failed-intercom-child'),
      replaceTools: vi.fn(async () => {
        throw new Error('tool install failed');
      }),
    } as DirectHarnessRuntime;
    const intercom = {
      bindRuntime: vi.fn(() => ({
        name: 'intercom',
        description: 'direct',
        parameters: {},
        execute: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
      })),
      dispose: vi.fn(),
    };
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: '/tmp',
      runtimeFactory: runtimeFactory(runtime),
    });

    await expect(service.start({ ...request({ kind: 'fresh' }), intercom })).rejects.toThrow('tool install failed');
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(intercom.dispose).toHaveBeenCalledOnce();
  });

  it('rejects unsupported sources and malformed model references before runtime creation', async () => {
    const factory = runtimeFactory(fakeRuntime('unused'));
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent',
      cwd: '/tmp',
      runtimeFactory: factory,
    });
    await expect(
      service.start(
        request({ kind: 'terminal-pi-fork', snapshotJsonl: '{}', sourceSessionId: 'source', sourceLeafId: 'leaf' }),
      ),
    ).rejects.toThrow('do not support terminal Pi sources');
    for (const model of ['invalid', '/model', 'provider/']) {
      await expect(service.start({ ...request({ kind: 'fresh' }), runId: `run-${model}`, model })).rejects.toThrow(
        'provider/model',
      );
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects unsupported native capability configuration before runtime creation', async () => {
    const factory = runtimeFactory(fakeRuntime('unused'));
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent',
      cwd: '/tmp',
      runtimeFactory: factory,
    });
    const configurations: Array<Partial<DoomChildSessionRequest>> = [
      { extensions: ['extension.ts'] },
      { subagentOnlyExtensions: ['child.ts'] },
      { capabilityCeiling: { allowedExternalProfiles: ['work'] } },
    ];
    for (const [index, configuration] of configurations.entries()) {
      await expect(
        service.start({ ...request({ kind: 'fresh' }), runId: `unsupported-${index}`, ...configuration }),
      ).rejects.toThrow('unsupported by the direct harness');
    }
    await expect(
      service.start({ ...request({ kind: 'fresh' }), runId: 'unknown-tool', tools: ['unknown'] }),
    ).rejects.toThrow('unknown direct harness tools: unknown');
    await expect(
      service.start({
        ...request({ kind: 'fresh' }),
        runId: 'missing-required-tool',
        tools: ['read'],
        capabilityCeiling: { requiredTools: ['bash'] },
      }),
    ).rejects.toThrow('requires unavailable tools: bash');
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(['mcp', 'mcp_use'])(
    'runs the requested %s direct declarations through the parent MCP runtime',
    async (name) => {
      const factory = runtimeFactory(fakeRuntime('mcp-child'));
      const content = [{ type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }];
      const execute = vi.fn(async () => ({ content, details: { server: 'docs' } }));
      const direct = { name: 'docs_search', description: 'Search docs', parameters: { type: 'object' }, execute };
      const dispatcher = {
        name: 'mcp',
        description: 'Private dispatch',
        parameters: {},
        execute,
        catalog: {
          snapshot: () => [direct],
          resolveSelectors: () => ['docs_search'],
          subscribe: () => () => undefined,
        },
      };
      const mcpTool = vi.fn(() => dispatcher);
      const service = createHeadlessChildSessionService({
        parentSessionId: 'parent',
        cwd: '/tmp',
        runtimeFactory: factory,
        mcpTool,
      });
      const handle = await service.start({ ...request({ kind: 'fresh' }), tools: ['read', name] });
      expect(factory.mock.calls[0]?.[0].activeToolNames).toEqual(['read', 'docs_search']);
      const tool = factory.mock.calls[0]?.[0].tools?.find((tool) => tool.name === 'docs_search');
      const signal = new AbortController().signal;
      const parameters = { server: 'docs', tool: 'search', arguments: { query: 'templates' } };
      const result = await tool!.execute(
        'mcp-call',
        parameters,
        vi.fn(),
        undefined,
        {} as never,
        { abortSignal: signal } as never,
      );
      expect(execute).toHaveBeenCalledWith('mcp-call', parameters, signal, expect.any(Function));
      expect(result).toEqual({ content, details: { server: 'docs' } });
      expect(mcpTool).toHaveBeenCalled();
      await handle.dispose();
    },
  );

  it.each([
    { capabilityCeiling: { allowMcpTools: false } },
    { capabilityCeiling: { allowedTools: ['read'] } },
    { capabilityCeiling: { allowedTools: ['read'], allowMcpTools: true } },
    { excludeTools: ['mcp'] },
    { excludeTools: ['mcp_use'] },
  ])('does not resolve MCP when a child policy denies it: %j', async (policy) => {
    const factory = runtimeFactory(fakeRuntime('bounded-child'));
    const mcpTool = vi.fn(() => undefined);
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent',
      cwd: '/tmp',
      runtimeFactory: factory,
      mcpTool,
    });
    const handle = await service.start({ ...request({ kind: 'fresh' }), tools: ['read', 'mcp', 'mcp_use'], ...policy });
    expect(factory.mock.calls[0]?.[0].activeToolNames).toEqual(['read']);
    expect(mcpTool).not.toHaveBeenCalled();
    await handle.dispose();
  });

  it('fails before opening a child journal when MCP is unavailable or required but denied', async () => {
    const factory = runtimeFactory(fakeRuntime('unused'));
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent',
      cwd: '/tmp',
      runtimeFactory: factory,
    });
    const source = { kind: 'v4-fork' as const, sessionFile: '/missing/parent.sqlite', branch: 'main' };
    await expect(service.start({ ...request(source), tools: ['mcp'] })).rejects.toThrow('MCP tools are unavailable');
    await expect(
      service.start({
        ...request(source),
        tools: ['mcp'],
        capabilityCeiling: { requiredTools: ['mcp'], allowMcpTools: false },
      }),
    ).rejects.toThrow('requires unavailable tools: mcp');
    await expect(service.start({ ...request(source), tools: ['toString'] })).rejects.toThrow(
      'unknown direct harness tools: toString',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects stale MCP dispatchers and surfaces upstream tool errors as failures', async () => {
    const factory = runtimeFactory(fakeRuntime('mcp-errors'));
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'permission denied' }],
      isError: true,
    }));
    const direct = { name: 'docs_search', description: 'Search docs', parameters: { type: 'object' }, execute };
    const dispatcher = {
      name: 'mcp',
      description: 'Private dispatch',
      parameters: {},
      execute,
      catalog: { snapshot: () => [direct], resolveSelectors: () => ['docs_search'], subscribe: () => () => undefined },
    };
    let active: typeof dispatcher | undefined = dispatcher;
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent',
      cwd: '/tmp',
      runtimeFactory: factory,
      mcpTool: () => active,
    });
    const handle = await service.start({ ...request({ kind: 'fresh' }), tools: ['mcp'] });
    const tool = factory.mock.calls[0]![0].tools![0]!;
    const call = () => tool.execute('call', {}, vi.fn(), undefined, {} as never, {} as never);
    await expect(call()).rejects.toThrow('permission denied');
    active = undefined;
    await expect(call()).rejects.toThrow('no longer available');
    active = { ...dispatcher };
    await expect(call()).rejects.toThrow('no longer available');
    expect(execute).toHaveBeenCalledOnce();
    await handle.dispose();
  });

  it('intersects direct selectors, exact grants, aliases, exclusions and explicit MCP permission', () => {
    const tools = ['personal_search', 'work_search'].map((name) => ({
      name,
      description: name,
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      execute: async () => ({ content: [] }),
    }));
    const provider = {
      name: 'mcp',
      description: '',
      parameters: {},
      execute: async () => ({ content: [] }),
      catalog: {
        snapshot: () => tools,
        resolveSelectors: (selectors: readonly string[]) =>
          selectors.includes('*')
            ? tools.map((tool) => tool.name)
            : selectors.includes('work/search') || selectors.includes('work')
              ? ['work_search']
              : [],
        subscribe: () => () => undefined,
      },
    };
    const base = { ...request({ kind: 'fresh' }), tools: ['read', 'mcp_use'], mcpDirectTools: ['work/search'] };
    const names = (policy: Partial<DoomChildSessionRequest>) =>
      composeDirectHarnessRequestOptions({ ...base, ...policy }, () => provider).activeToolNames;
    expect(names({})).toEqual(['read', 'work_search']);
    expect(names({ capabilityCeiling: { allowedTools: ['read', 'mcp'], allowMcpTools: true } })).toEqual([
      'read',
      'work_search',
    ]);
    expect(names({ capabilityCeiling: { allowedTools: ['read', 'personal_search'], allowMcpTools: true } })).toEqual([
      'read',
    ]);
    expect(names({ capabilityCeiling: { allowedTools: ['read', 'mcp'] } })).toEqual(['read']);
    expect(names({ capabilityCeiling: { allowedTools: ['read', 'mcp'], allowMcpTools: false } })).toEqual(['read']);
    expect(names({ excludeTools: ['work_search'] })).toEqual(['read']);
    expect(names({ excludeTools: ['mcp'] })).toEqual(['read']);
    expect(names({ mcpDirectTools: ['missing/tool'] })).toEqual(['read']);
    expect(names({ tools: ['personal_search'] })).toEqual([]);
    expect(names({ tools: ['personal_search'], mcpDirectTools: ['*'] })).toEqual(['personal_search']);
    expect(names({ tools: ['read'] })).toEqual(['read']);
    expect(names({ tools: undefined })).toContain('work_search');
    expect(names({ tools: undefined })).not.toContain('personal_search');
    expect(() =>
      names({ capabilityCeiling: { allowedTools: ['read'], allowMcpTools: true, requiredTools: ['work_search'] } }),
    ).toThrow('requires unavailable tools: work_search');
  });

  it('refreshes late catalogs, preserves native tools and bound intercom, and retires same-name providers', async () => {
    const runtime = fakeRuntime('live');
    const replace = vi.fn(async (_tools: Parameters<DirectHarnessRuntime['replaceTools']>[0]) => undefined);
    runtime.replaceTools = replace;
    const direct = {
      name: 'work_search',
      description: 'Search',
      parameters: { type: 'object' },
      execute: vi.fn(async () => ({ content: [] })),
    };
    let snapshot: (typeof direct)[] = [];
    let changed: (() => void) | undefined;
    let providerChanged: (() => void) | undefined;
    const unsubscribed = vi.fn();
    const provider = {
      name: 'mcp',
      description: '',
      parameters: {},
      execute: async () => ({ content: [] }),
      catalog: {
        snapshot: () => snapshot,
        resolveSelectors: () => ['work_search'],
        subscribe: (listener: () => void) => {
          changed = listener;
          return unsubscribed;
        },
      },
    };
    let active: typeof provider | undefined = provider;
    const ownedRequest = { ...request({ kind: 'fresh' }), tools: ['read', 'mcp'], intercom: { bindRuntime: vi.fn() } };
    const initial = composeDirectHarnessRequestOptions(ownedRequest, () => active).tools!;
    const intercom = { name: 'bound_team_bus', description: '', parameters: {}, execute: vi.fn() };
    const release = bindChildMcpCatalog(
      runtime,
      ownedRequest,
      {
        mcpTool: () => active,
        subscribeMcpTool: (listener) => {
          providerChanged = listener;
          return unsubscribed;
        },
      },
      [...initial, intercom] as never,
    );
    snapshot = [direct];
    changed!();
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    const surface = replace.mock.calls.at(-1)![0] as unknown as NonNullable<DirectHarnessRuntimeOptions['tools']>;
    expect(surface.map((tool) => tool.name)).toEqual(['read', 'bound_team_bus', 'work_search']);
    expect(surface[0]).toBe(initial[0]);
    expect(surface[1]).toBe(intercom);
    const call = () => surface[2]!.execute('call', {}, vi.fn(), undefined, {} as never, {} as never);
    await call();
    const count = replace.mock.calls.length;
    changed!();
    await Promise.resolve();
    expect(replace).toHaveBeenCalledTimes(count);
    active = { ...provider };
    providerChanged!();
    await expect(call()).rejects.toThrow('no longer available');
    active = undefined;
    providerChanged!();
    await vi.waitFor(() => expect(replace.mock.calls.at(-1)![0]).toHaveLength(2));
    release();
    expect(unsubscribed).toHaveBeenCalledTimes(3);
    expect(ownedRequest.intercom.bindRuntime).not.toHaveBeenCalled();
  });

  it('projects native tools, skills, prompt mode, exclusions, and capability ceilings', async () => {
    const runtime = fakeRuntime('configured-tools');
    const factory = runtimeFactory(runtime);
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent',
      cwd: '/tmp',
      runtimeFactory: factory,
    });

    const handle = await service.start({
      ...request({ kind: 'fresh' }),
      tools: ['read', 'grep', 'bash'],
      excludeTools: ['bash'],
      skills: ['testing'],
      systemPrompt: 'extra',
      systemPromptMode: 'append',
      capabilityCeiling: { allowedTools: ['read', 'grep'], requiredTools: ['read'] },
    });

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'extra',
        activeToolNames: ['read', 'grep'],
        tools: [expect.objectContaining({ name: 'read' }), expect.objectContaining({ name: 'grep' })],
      }),
    );
    const readTool = factory.mock.calls[0]?.[0].tools?.find((tool) => tool.name === 'read');
    const readResult = await readTool!.execute(
      'read-call',
      { path: import.meta.filename },
      vi.fn(),
      undefined,
      {} as never,
      {} as never,
    );
    expect(readResult.content).toBeDefined();
    await handle.stop();
  });
  it('passes explicit child ceilings and default model policy to the direct runtime', async () => {
    const runtime = fakeRuntime('configured', '/tmp/configured.jsonl');
    runtime.submitInternalMessage = vi.fn(async () => ({ settled: new Promise<void>(() => undefined) }));
    const factory = runtimeFactory(runtime);
    const models = {} as HeadlessChildSessionServiceOptions['models'];
    const provider = createHeadlessChildSessionServiceProvider({
      parentSessionId: 'fallback-parent',
      cwd: '/fallback',
      sessionsRoot: '/sessions',
      models,
      defaultModel: () => ({ provider: 'default', id: 'model' }),
      runtimeFactory: factory,
      now: () => 1,
    });
    const service = provider.get();
    expect(service).toBeDefined();
    const handle = await service!.start({
      ...request({ kind: 'fresh' }, ''),
      parentSessionId: '',
      thinking: 'high',
      systemPrompt: 'bounded prompt',
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/fallback',
        parentSessionId: 'fallback-parent',
        sessionsRoot: '/sessions',
        models,
        model: { provider: 'default', id: 'model' },
        thinkingLevel: 'high',
        systemPrompt: 'bounded prompt',
      }),
    );
    expect(handle.sessionFile).toBe('/tmp/configured.jsonl');
    await handle.steer('next');
    expect(runtime.submitInternalMessage).toHaveBeenCalledWith('next', 'steer');
    expect(runtime.steer).not.toHaveBeenCalled();
    expect(runtime.followUp).not.toHaveBeenCalled();
    await handle.stop();
    await provider.close();
  });

  it('splits a thinking suffix off the model id and resolves providers per spawn', async () => {
    const runtime = fakeRuntime('suffixed', '/tmp/suffixed.jsonl');
    runtime.submitInternalMessage = vi.fn(async () => ({ settled: new Promise<void>(() => undefined) }));
    const factory = runtimeFactory(runtime);
    const providers = vi.fn(() => [{ id: 'anthropic-vertex' } as never]);
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: '/workspace',
      providers,
      runtimeFactory: factory,
    });

    const handle = await service.start({
      ...request({ kind: 'fresh' }, '/workspace'),
      model: 'anthropic-vertex/claude-sonnet-5:medium',
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: 'anthropic-vertex', id: 'claude-sonnet-5' },
        thinkingLevel: 'medium',
        providers: [{ id: 'anthropic-vertex' }],
      }),
    );
    expect(providers).toHaveBeenCalledTimes(1);
    await handle.stop();
    await service.close();
  });

  it.each(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'splits the :%s thinking suffix off the child model id',
    async (level) => {
      const runtime = fakeRuntime(`suffix-${level}`, `/tmp/suffix-${level}.jsonl`);
      runtime.submitInternalMessage = vi.fn(async () => ({ settled: new Promise<void>(() => undefined) }));
      const factory = runtimeFactory(runtime);
      const service = createHeadlessChildSessionService({
        parentSessionId: 'parent-session',
        cwd: '/workspace',
        runtimeFactory: factory,
      });

      const handle = await service.start({
        ...request({ kind: 'fresh' }, '/workspace'),
        model: `anthropic-vertex/claude-sonnet-5:${level}`,
      });
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { provider: 'anthropic-vertex', id: 'claude-sonnet-5' },
          thinkingLevel: level,
        }),
      );
      await handle.stop();
      await service.close();
    },
  );

  it('keeps a model id that ends in a thinking word without a colon intact', async () => {
    const runtime = fakeRuntime('unsuffixed', '/tmp/unsuffixed.jsonl');
    runtime.submitInternalMessage = vi.fn(async () => ({ settled: new Promise<void>(() => undefined) }));
    const factory = runtimeFactory(runtime);
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: '/workspace',
      runtimeFactory: factory,
    });

    const handle = await service.start({
      ...request({ kind: 'fresh' }, '/workspace'),
      model: 'anthropic-vertex/claude-opus-max',
    });
    const options = factory.mock.calls[0]?.[0];
    expect(options?.model).toEqual({ provider: 'anthropic-vertex', id: 'claude-opus-max' });
    expect(options).not.toHaveProperty('thinkingLevel');
    await handle.stop();
    await service.close();
  });

  it('omits providers from the runtime options when the per-spawn thunk resolves to none', async () => {
    const runtime = fakeRuntime('no-providers', '/tmp/no-providers.jsonl');
    runtime.submitInternalMessage = vi.fn(async () => ({ settled: new Promise<void>(() => undefined) }));
    const factory = runtimeFactory(runtime);
    const providers = vi.fn(() => []);
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: '/workspace',
      providers,
      runtimeFactory: factory,
    });

    const handle = await service.start(request({ kind: 'fresh' }, '/workspace'));
    expect(providers).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).not.toHaveProperty('providers');
    await handle.stop();
    await service.close();
  });

  it('keeps an explicit thinking request ahead of the model suffix', async () => {
    const runtime = fakeRuntime('explicit', '/tmp/explicit.jsonl');
    runtime.submitInternalMessage = vi.fn(async () => ({ settled: new Promise<void>(() => undefined) }));
    const factory = runtimeFactory(runtime);
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: '/workspace',
      runtimeFactory: factory,
    });

    const handle = await service.start({
      ...request({ kind: 'fresh' }, '/workspace'),
      model: 'anthropic-vertex/claude-sonnet-5:medium',
      thinking: 'high',
    });
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'high' }));
    await handle.stop();
    await service.close();
  });
  it('releases source and destination ownership when a fork cannot be admitted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-child-fork-lock-'));
    const sourcePath = await createSource(root);
    const sourceRelease = vi.fn();
    const destinationRelease = vi.fn();
    const destinationAssert = vi.fn(async () => {
      throw new Error('destination is busy');
    });
    const sourceLease = { assertQuiescent: vi.fn(), release: sourceRelease };
    const destinationLease = { assertQuiescent: destinationAssert, release: destinationRelease };
    const ownership = {
      acquire: vi.fn(async (ownedPath: string) =>
        ownedPath === fs.realpathSync(sourcePath) ? sourceLease : destinationLease,
      ),
    };
    const factory = runtimeFactory(fakeRuntime('unused'));
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: root,
      runtimeFactory: factory,
      historyOwnership: ownership,
    });
    try {
      await expect(
        service.start(request({ kind: 'v4-fork', sessionFile: sourcePath, branch: 'main' }, root)),
      ).rejects.toThrow('destination is busy');
      expect(factory).not.toHaveBeenCalled();
      expect(sourceLease.assertQuiescent).not.toHaveBeenCalled();
      expect(destinationAssert).toHaveBeenCalledOnce();
      expect(sourceRelease).not.toHaveBeenCalled();
      expect(destinationRelease).toHaveBeenCalledOnce();
    } finally {
      await service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a forked journal when factory cleanup cannot be confirmed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-child-fork-startup-'));
    const sourcePath = await createSource(root);
    const sourceRelease = vi.fn();
    const destinationRelease = vi.fn();
    const ownership = {
      acquire: vi.fn(async (ownedPath: string) =>
        ownedPath === fs.realpathSync(sourcePath)
          ? { assertQuiescent: vi.fn(), release: sourceRelease }
          : { assertQuiescent: vi.fn(), release: destinationRelease },
      ),
    };
    const factory = vi.fn(async (_options: DirectHarnessRuntimeOptions) => {
      throw new Error('child runtime failed');
    });
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent-session',
      cwd: root,
      runtimeFactory: factory,
      historyOwnership: ownership,
    });
    try {
      await expect(
        service.start(request({ kind: 'v4-fork', sessionFile: sourcePath, branch: 'main' }, root)),
      ).rejects.toThrow('child runtime failed');
      const forkPath = factory.mock.calls[0]?.[0].sessionPath;
      expect(forkPath).toEqual(expect.any(String));
      expect(fs.existsSync(forkPath!)).toBe(true);
      expect(sourceRelease).not.toHaveBeenCalled();
      expect(destinationRelease).toHaveBeenCalledOnce();
    } finally {
      await service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('preserves a fork journal when runtime disposal fails during startup cleanup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-child-fork-dispose-'));
    const sourcePath = await createSource(root);
    const startupError = new Error('installation failed');
    const disposeError = new Error('dispose failed');
    const runtime = fakeRuntime('child');
    runtime.setThinkingLevel = vi.fn(async () => {
      throw startupError;
    });
    runtime.dispose = vi.fn(async () => {
      throw disposeError;
    });
    const intercomError = new Error('intercom cleanup failed');
    const intercom = {
      bindRuntime: vi.fn(),
      dispose: vi.fn(() => {
        throw intercomError;
      }),
    };
    const factory = vi.fn(async (_options: DirectHarnessRuntimeOptions) => runtime);
    const service = createHeadlessChildSessionService({
      parentSessionId: 'parent',
      cwd: root,
      runtimeFactory: factory,
    });
    try {
      await expect(
        service.start({
          ...request({ kind: 'v4-fork', sessionFile: sourcePath, branch: 'main' }, root),
          thinking: 'low',
          intercom,
        }),
      ).rejects.toMatchObject({ errors: [startupError, disposeError, intercomError] });
      expect(fs.existsSync(factory.mock.calls[0]![0].sessionPath!)).toBe(true);
    } finally {
      await service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
