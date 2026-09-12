import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { laneConfig, laneState } from '@earendil-works/pi-agent-core/harness/session';
import { SqliteSessionRepo, createNodeSqliteFactory } from '@earendil-works/pi-session-backend-sqlite-node';
import type { DoomChildSessionRequest } from '@agimon-ai/doompi-extension-contracts/child-session';
import type {
  DirectHarnessRuntime,
  DirectHarnessRuntimeOptions,
} from '../../../../src/controllers/directHarnessRuntime';
import {
  createHeadlessChildSessionService,
  createHeadlessChildSessionServiceProvider,
  type HeadlessChildSessionServiceOptions,
} from '../../../../src/controllers/headlessChildSessionService';

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
    readEntries: async () => ({ entries: [], leafId: null }),
    listCommands: () => [],
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
    appendCustomEntry: async () => 'entry',
    recordUsage: async () => 'usage',
    submitPrompt: vi.fn(async () => ({ settled: Promise.resolve() })),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

function runtimeFactory(runtime: DirectHarnessRuntime) {
  return vi.fn(async (_options: DirectHarnessRuntimeOptions) => runtime);
}

async function createSource(root: string): Promise<string> {
  const repository = new SqliteSessionRepo({ directory: root, databaseFactory: createNodeSqliteFactory() });
  const session = await repository.create({ id: 'source' }, BACKGROUND_CONTEXT);
  const main = await session.createBranch('main', null, BACKGROUND_CONTEXT);
  const message = { role: 'user', content: [{ type: 'text', text: 'source' }] } as Parameters<
    typeof main.appendMessage
  >[0];
  await main.appendMessage(message, BACKGROUND_CONTEXT);
  await session.setValue(
    laneConfig('main'),
    { model: { provider: 'test', modelId: 'test' }, thinkingLevel: 'off', activeToolNames: [] },
    BACKGROUND_CONTEXT,
  );
  await session.setValue(
    laneState('main'),
    { currentOperationId: null, lastOperationId: null, inbox: [] },
    BACKGROUND_CONTEXT,
  );
  const sourcePath = session.metadata.path;
  await session.close(BACKGROUND_CONTEXT);
  await repository.close(BACKGROUND_CONTEXT);
  return sourcePath;
}

describe('headless child session provider', () => {
  beforeEach(() => vi.restoreAllMocks());

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
      new AbortController().signal,
      undefined,
    );
    expect(execute).toHaveBeenCalledWith('operation', { action: 'members' }, expect.any(AbortSignal), undefined);

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
      { mcpDirectTools: ['server/tool'] },
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
    runtime.prompt = vi.fn(() => new Promise<void>(() => undefined));
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
    expect(runtime.steer).toHaveBeenCalledWith('next');
    await handle.stop();
    await provider.close();
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
        service.start(request({ kind: 'v4-fork', sessionFile: sourcePath, branch: 'busy' }, root)),
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

  it('removes a forked journal when child runtime startup fails', async () => {
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
      expect(fs.existsSync(forkPath!)).toBe(false);
      expect(sourceRelease).not.toHaveBeenCalled();
      expect(destinationRelease).toHaveBeenCalledOnce();
    } finally {
      await service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
