import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAssistantMessageEventStream, type Models, type Model, type Api } from '@earendil-works/pi-ai';
import type { Extension, LoadExtensionsResult, RegisteredTool, SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  createExtensionRuntime,
  ExtensionRunner,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDirectHarnessRuntime } from '../../../../src/server/directHarnessRuntime';
import {
  createBridgedSessionManager,
  createPiExtensionHost,
  preloadPiExtensions,
  resolvePiExtensionEntries,
  resolvePiSettingsPackageEntries,
} from '../../../../src/services/piExtensionHost';
import type { AgentMessage, Entry, HarnessEvent } from '../../../../src/types/server/directHarnessRuntime';
import type { DirectHarnessRuntime } from '../../../../src/types/server/directHarnessRuntime';

const CREATED_AT = 1_700_000_000_000;

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-extension-host-'));
  temporaryRoots.push(root);
  return root;
}

interface StubRuntime {
  runtime: DirectHarnessRuntime;
  appended: { customType: string; data: unknown }[];
  emit(event: HarnessEvent): Promise<void>;
  readEntries: ReturnType<typeof vi.fn<DirectHarnessRuntime['readEntries']>>;
}

function stubRuntime(entries: Entry[], options?: { parentSessionId?: string; failWrites?: boolean }): StubRuntime {
  const appended: { customType: string; data: unknown }[] = [];
  let nextEntryId = 1;
  let listener: ((event: HarnessEvent, context: never) => void | Promise<void>) | undefined;
  const readEntries = vi.fn(async () => ({ entries, leafId: entries.at(-1)?.id ?? null }));
  const runtime = {
    sessionId: 'session-1',
    session: {
      snapshot: async () => ({
        id: 'session-1',
        createdAt: CREATED_AT,
        parentSessionId: options?.parentSessionId ?? '',
        workspaceRoot: '/workspace/project',
      }),
      metadata: {
        id: 'session-1',
        createdAt: CREATED_AT,
        storageVersion: 1,
        cwd: '/workspace/project',
        ...(options?.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
      },
    },
    readEntries,
    submitUserPrompt: vi.fn(async () => ({ settled: Promise.resolve() })),
    submitPrompt: vi.fn(async () => ({ settled: Promise.resolve() })),
    submitInternalMessage: vi.fn(async () => ({ settled: Promise.resolve() })),
    admitMessage: vi.fn(async () => ({ settled: Promise.resolve() })),
    appendMessage: vi.fn(async () => 'message-1'),
    dispatchCommand: vi.fn(async () => true),
    followUp: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    readState: async () => ({ pendingMessageCount: 0 }),
    readLifecycle: async () => ({ revision: 0, operation: null, paused: false, queue: [] }),
    onPresentationFrame: () => () => undefined,
    appendCustomEntry: async (customType: string, data: unknown) => {
      if (options?.failWrites === true) throw new Error('storage is quarantined');
      appended.push({ customType, data });
      const entry: Entry = {
        type: 'custom',
        id: `appended-${nextEntryId++}`,
        parentId: entries.at(-1)?.id ?? null,
        seq: entries.length + 1,
        timestamp: CREATED_AT,
        customType,
        data: data as never,
      };
      entries.push(entry);
      await listener?.({ type: 'entry_added', lane: 'main', entry }, undefined as never);
      return entry.id;
    },
    onEvent: (next: typeof listener) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as DirectHarnessRuntime;
  return {
    runtime,
    appended,
    readEntries,
    async emit(event) {
      if (event.type === 'entry_added') entries.push(event.entry);
      await listener?.(event, undefined as never);
    },
  };
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    // The settings and model runtimes can still be flushing files into the root as it is
    // removed; retrying covers the ENOTEMPTY that race produces on slower CI disks.
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('resolvePiExtensionEntries', () => {
  it('contributes nothing when the worktree has no sync registration', () => {
    expect(resolvePiExtensionEntries(temporaryRoot())).toEqual([]);
  });

  it('contributes nothing when the registration is unreadable rather than failing the session', () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, '.doompi-sync.json'), 'not json at all');
    expect(resolvePiExtensionEntries(root)).toEqual([]);
  });
});

/** A provider extension, as a local package directory with a Pi manifest. */
const PROVIDER_EXTENSION = `export default function (pi) {
  pi.registerProvider('settings-bridge', {
    baseUrl: 'settings-bridge',
    apiKey: 'not-used',
    api: 'settings-bridge',
    models: [{ id: 'bridge-model', name: 'Bridge Model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    streamSimple: () => { throw new Error('not streamed in tests'); },
  });
}
`;

function writeSettingsFixture(): { cwd: string; agentDir: string; packageEntry: string } {
  const cwd = temporaryRoot();
  const agentDir = temporaryRoot();
  const packageDir = path.join(agentDir, 'local', 'provider-package');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'provider-package', pi: { extensions: ['./index.mjs'] } }),
  );
  writeFileSync(path.join(packageDir, 'index.mjs'), PROVIDER_EXTENSION);
  // A top-level extension and an auto-discovered one: both are Pi's own loading paths, not packages.
  writeFileSync(path.join(agentDir, 'top-level.mjs'), 'export default function () {}\n');
  mkdirSync(path.join(agentDir, 'extensions'));
  writeFileSync(path.join(agentDir, 'extensions', 'auto.mjs'), 'export default function () {}\n');
  writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: ['local/provider-package', 'npm:@doompi-test/not-installed-provider'],
      extensions: ['top-level.mjs'],
    }),
  );
  return { cwd, agentDir, packageEntry: path.join(packageDir, 'index.mjs') };
}

describe('resolvePiSettingsPackageEntries', () => {
  it('returns only the extensions of settings packages', async () => {
    const { cwd, agentDir, packageEntry } = writeSettingsFixture();
    const entries = await resolvePiSettingsPackageEntries({
      cwd,
      agentDir,
      settings: SettingsManager.create(cwd, agentDir),
    });
    expect(entries).toEqual([packageEntry]);
  });

  it('skips a package that is not installed instead of installing it', async () => {
    const { cwd, agentDir } = writeSettingsFixture();
    const notices: string[] = [];
    await resolvePiSettingsPackageEntries({
      cwd,
      agentDir,
      settings: SettingsManager.create(cwd, agentDir),
      onNotice: (message) => notices.push(message),
    });
    expect(notices).toEqual([expect.stringContaining('@doompi-test/not-installed-provider is not installed')]);
    expect(existsSync(path.join(agentDir, 'npm'))).toBe(false);
  });

  it('starts vanilla Pi extensions without requiring a Doom Cordis host', async () => {
    const { cwd, agentDir, packageEntry } = writeSettingsFixture();
    const started = path.join(agentDir, 'started');
    writeFileSync(
      packageEntry,
      PROVIDER_EXTENSION.replace(
        '  pi.registerProvider',
        `  pi.on('session_start', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(${JSON.stringify(started)}, 'started');
  });
  pi.registerProvider`,
      ),
    );
    const models = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    const preload = await preloadPiExtensions({ cwd, agentDir, models, extensionPaths: [packageEntry] });
    initTheme(undefined, false);
    const host = createPiExtensionHost({
      cwd,
      agentDir,
      models,
      settings: SettingsManager.inMemory(),
      runtime: stubRuntime([]).runtime,
      preload,
      getModel: () => undefined,
      getThinkingLevel: () => 'off',
      client: () => undefined,
    });
    try {
      await host.load();
      expect(existsSync(started)).toBe(true);
      expect(host.getService('doom/runtime')).toBeUndefined();
    } finally {
      await host.shutdown();
    }
  });

  it('registers a settings package provider on the model runtime', async () => {
    const { cwd, agentDir } = writeSettingsFixture();
    const models = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    await preloadPiExtensions({
      cwd,
      agentDir,
      models,
      extensionPaths: await resolvePiSettingsPackageEntries({
        cwd,
        agentDir,
        settings: SettingsManager.create(cwd, agentDir),
      }),
    });
    const available = await models.getAvailable();
    expect(available.map((model) => `${model.provider}/${model.id}`)).toContain('settings-bridge/bridge-model');
  });
});

describe('createBridgedSessionManager', () => {
  it('hydrates the manager from the harness session instead of opening a second connection', async () => {
    const entries: Entry[] = [
      {
        type: 'message',
        id: 'entry-1',
        parentId: null,
        seq: 1,
        timestamp: CREATED_AT,
        message: { role: 'user', content: 'hello', timestamp: CREATED_AT },
      },
    ];
    const { runtime } = stubRuntime(entries);

    const manager = await createBridgedSessionManager(runtime, '/fallback');

    expect(manager.getSessionId()).toBe('session-1');
    // inMemory never touches disk, so there is no second SQLite connection and no second lease.
    expect(manager.getSessionFile()).toBeUndefined();
    expect(manager.getHeader()).toMatchObject({ type: 'session', id: 'session-1', cwd: '/workspace/project' });
    expect(manager.getEntries()[0]).toMatchObject({ type: 'message', id: 'entry-1', parentId: null });
  });

  it('mirrors an extension-authored custom entry back through the harness', async () => {
    const { runtime, appended } = stubRuntime([]);
    const manager = await createBridgedSessionManager(runtime, '/fallback');

    manager.appendCustomEntry('team.handoff', { to: 'reviewer' });

    expect(appended).toEqual([{ customType: 'team.handoff', data: { to: 'reviewer' } }]);
  });

  it('mirrors a Pi-only entry type under the reserved prefix', async () => {
    const { runtime, appended } = stubRuntime([]);
    const manager = await createBridgedSessionManager(runtime, '/fallback');

    manager.appendModelChange('anthropic', 'claude');

    expect(appended).toHaveLength(1);
    expect(appended[0]?.customType).toBe('pi.model_change');
  });

  it('does not mirror agent-loop entries back, which would double-record them', async () => {
    const { runtime, appended } = stubRuntime([]);
    const manager = await createBridgedSessionManager(runtime, '/fallback');

    manager.appendMessage({ role: 'user', content: 'hello', timestamp: CREATED_AT });

    expect(appended).toEqual([]);
  });

  it('reports a failed mirror through onNotice rather than rejecting unhandled', async () => {
    const { runtime } = stubRuntime([], { failWrites: true });
    const onNotice = vi.fn();
    const manager = await createBridgedSessionManager(runtime, '/fallback', onNotice);

    manager.appendCustomEntry('team.handoff', { to: 'reviewer' });
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1));

    expect(onNotice.mock.calls[0]?.[0]).toContain('storage is quarantined');
  });

  it('keeps the entry in Pi-visible history even when the mirror fails', async () => {
    const { runtime } = stubRuntime([], { failWrites: true });
    const manager = await createBridgedSessionManager(runtime, '/fallback', () => {});

    manager.appendCustomEntry('team.handoff', { to: 'reviewer' });

    expect(manager.getEntries().at(-1)).toMatchObject({ type: 'custom', customType: 'team.handoff' });
  });

  it('carries the parent session through to the Pi header', async () => {
    const { runtime } = stubRuntime([], { parentSessionId: 'session-0' });
    const manager = await createBridgedSessionManager(runtime, '/fallback');

    expect(manager.getHeader()).toMatchObject({ type: 'session', parentSession: 'session-0' });
  });
});

describe('Pi SessionManager contract', () => {
  // The bridge intercepts _persist, which is public in Pi's shipped types but is not a documented
  // extension point. If a Pi release renames it, this fails here instead of silently dropping
  // every extension-authored session write.
  it('still exposes _persist as the single append persistence hook', () => {
    const manager = SessionManager.inMemory('/workspace/project');
    expect(typeof manager._persist).toBe('function');
  });

  it('routes every append through _persist', () => {
    const manager = SessionManager.inMemory('/workspace/project');
    const seen: SessionEntry[] = [];
    manager._persist = (entry) => {
      seen.push(entry);
    };

    manager.appendCustomEntry('probe', {});
    manager.appendMessage({ role: 'user', content: 'hello', timestamp: CREATED_AT });

    expect(seen.map((entry) => entry.type)).toEqual(['custom', 'message']);
  });
});

describe('Pi extension UI theme access', () => {
  // The headless UI context needs Pi's Theme, whose singleton module is not in the package
  // exports map. A fresh runner's no-op UI context is the only supported route to it.
  it('exposes a theme through the runner rather than a blocked deep import', () => {
    const manager = SessionManager.inMemory('/workspace/project');
    const runner = new ExtensionRunner(
      [],
      { flagValues: new Map() } as unknown as ConstructorParameters<typeof ExtensionRunner>[1],
      '/workspace/project',
      manager,
      new ModelRegistry({} as unknown as ConstructorParameters<typeof ModelRegistry>[0]),
    );

    expect(runner.hasUI()).toBe(false);
    initTheme(undefined, false);
    expect(runner.getUIContext().theme.constructor.name).toBe('Theme');
  });
});

function stubExtension(names: readonly string[], handlers: Map<string, unknown> = new Map()): Extension {
  const tools = new Map<string, RegisteredTool>();
  for (const name of names) {
    tools.set(name, {
      definition: {
        name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        promptGuidelines: [`Use ${name} only when it applies.`],
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      },
      sourceInfo: { extensionPath: `/extensions/${name}.mjs` },
    } as unknown as RegisteredTool);
  }
  return {
    path: '/extensions/stub.mjs',
    tools,
    handlers,
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
    messageRenderers: new Map(),
  } as unknown as Extension;
}

async function loadedHost(
  names: readonly string[],
  onActiveToolsChanged?: () => void,
  handlers: Map<string, unknown> = new Map(),
  onNotice?: (message: string) => void,
  prepare?: (runtime: DirectHarnessRuntime) => void,
) {
  const stub = stubRuntime([]);
  prepare?.(stub.runtime);
  const preload: LoadExtensionsResult = {
    extensions: [stubExtension(names, handlers)],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  initTheme(undefined, false);
  const host = createPiExtensionHost({
    cwd: '/workspace/project',
    agentDir: '/workspace/project/.pi',
    models: {} as unknown as ConstructorParameters<typeof ModelRegistry>[0],
    settings: SettingsManager.inMemory(),
    runtime: stub.runtime,
    preload,
    getModel: () => undefined,
    getThinkingLevel: () => 'off',
    client: () => undefined,
    onNotice,
    ...(onActiveToolsChanged === undefined ? {} : { onActiveToolsChanged }),
  });
  await host.load();
  // bindCore copies the host's actions onto the shared runtime, which is the object every
  // extension's ExtensionAPI calls through. Reaching it here exercises the real seam.
  return {
    host,
    actions: preload.runtime,
    runtime: stub.runtime,
    emit: stub.emit,
    readEntries: stub.readEntries,
    appended: stub.appended,
  };
}

describe('Pi extension tool surface in the headless host', () => {
  it('tracks hidden retained pending work and fences late snapshot reads', async () => {
    const pending = vi.fn();
    let publish!: Parameters<DirectHarnessRuntime['onPresentationFrame']>[0];
    let finishOld!: (state: Record<string, unknown>) => void;
    const old = new Promise<Record<string, unknown>>((resolve) => {
      finishOld = resolve;
    });
    let finishShutdown!: (state: Record<string, unknown>) => void;
    const shutdownRead = new Promise<Record<string, unknown>>((resolve) => {
      finishShutdown = resolve;
    });
    const { host } = await loadedHost(
      [],
      undefined,
      new Map([
        [
          'session_start',
          [
            (_event: unknown, context: { hasPendingMessages(): boolean }) => {
              pending.mockImplementation(() => context.hasPendingMessages());
            },
          ],
        ],
      ]),
      undefined,
      (runtime) => {
        runtime.readState = vi
          .fn()
          .mockResolvedValueOnce({ pendingMessageCount: 2 })
          .mockReturnValueOnce(old)
          .mockResolvedValueOnce({ pendingMessageCount: 0 })
          .mockReturnValueOnce(shutdownRead);
        runtime.onPresentationFrame = (listener) => {
          publish = listener;
          return () => undefined;
        };
      },
    );
    try {
      expect(pending()).toBe(true);
      const frame = { type: 'lifecycle_update', lifecycle: { revision: 1, operation: null, paused: true, queue: [] } };
      publish(frame);
      publish(frame);
      await vi.waitFor(() => expect(pending()).toBe(false));
      finishOld({ pendingMessageCount: 3 });
      await Promise.resolve();
      expect(pending()).toBe(false);
      publish(frame);
      await host.shutdown();
      finishShutdown({ pendingMessageCount: 4 });
      await Promise.resolve();
      expect(pending()).toBe(false);
    } finally {
      await host.shutdown();
    }
  });
  it('awaits fresh pending state before settlement and ignores an older lifecycle snapshot', async () => {
    const pending = vi.fn();
    const ends = vi.fn((_event: unknown, context: { hasPendingMessages(): boolean }) => {
      expect(context.hasPendingMessages()).toBe(false);
    });
    const settled = vi.fn((_event: unknown, context: { hasPendingMessages(): boolean }) => {
      expect(context.hasPendingMessages()).toBe(false);
    });
    let publish!: Parameters<DirectHarnessRuntime['onPresentationFrame']>[0];
    let finishOld!: (state: Record<string, unknown>) => void;
    const old = new Promise<Record<string, unknown>>((resolve) => {
      finishOld = resolve;
    });
    let finishFresh!: (state: Record<string, unknown>) => void;
    const fresh = new Promise<Record<string, unknown>>((resolve) => {
      finishFresh = resolve;
    });
    const readState = vi
      .fn()
      .mockResolvedValueOnce({ pendingMessageCount: 1 })
      .mockReturnValueOnce(old)
      .mockReturnValueOnce(fresh)
      .mockReturnValueOnce(old);
    const { host, emit } = await loadedHost(
      [],
      undefined,
      new Map<string, unknown>([
        [
          'session_start',
          [
            (_event: unknown, context: { hasPendingMessages(): boolean }) => {
              pending.mockImplementation(() => context.hasPendingMessages());
            },
          ],
        ],
        ['agent_end', [ends]],
        ['agent_settled', [settled]],
      ]),
      undefined,
      (runtime) => {
        runtime.readState = readState;
        runtime.onPresentationFrame = (listener) => {
          publish = listener;
          return () => undefined;
        };
      },
    );
    try {
      await emit({ type: 'run_start', lane: 'main', runId: 'run', startedAt: CREATED_AT });
      publish({ type: 'lifecycle_update', lifecycle: { revision: 1, operation: null, paused: true, queue: [] } });
      const ending = emit({
        type: 'run_end',
        lane: 'main',
        runId: 'run',
        fromTipId: null,
        tipId: null,
        endedAt: CREATED_AT,
        status: 'completed',
      });
      await vi.waitFor(() => expect(readState).toHaveBeenCalledTimes(3));
      // A lifecycle refresh started during settlement must not invalidate its awaited snapshot.
      publish({ type: 'lifecycle_update', lifecycle: { revision: 2, operation: null, paused: true, queue: [] } });
      expect(readState).toHaveBeenCalledTimes(4);
      expect(pending()).toBe(true);
      expect(ends).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      finishFresh({ pendingMessageCount: 0 });
      await ending;
      expect(ends).toHaveBeenCalledTimes(1);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(pending()).toBe(false);
      finishOld({ pendingMessageCount: 1 });
      await Promise.resolve();
      expect(pending()).toBe(false);
    } finally {
      await host.shutdown();
    }
  });
  it('settles without pending work once the authoritative read drained a queue the run consumed', async () => {
    const seen = vi.fn((_event: unknown, context: { hasPendingMessages(): boolean }) => context.hasPendingMessages());
    const { host, emit } = await loadedHost(
      [],
      undefined,
      new Map<string, unknown>([['agent_settled', [seen]]]),
      undefined,
      (runtime) => {
        runtime.readState = vi.fn(async () => ({ pendingMessageCount: 0 }));
      },
    );
    try {
      await emit({ type: 'run_start', lane: 'main', runId: 'run', startedAt: CREATED_AT });
      await emit({ type: 'queue_update', queues: [{ kind: 'followUp', id: 'q1' }] } as never);
      await emit({
        type: 'run_end',
        lane: 'main',
        runId: 'run',
        fromTipId: null,
        tipId: null,
        endedAt: CREATED_AT,
        status: 'completed',
      });
      expect(seen).toHaveReturnedWith(false);
    } finally {
      await host.shutdown();
    }
  });
  it('admits extension-generated user and custom content internally with explicit delivery', async () => {
    const { actions, runtime, emit } = await loadedHost([]);
    const content = [
      { type: 'text' as const, text: 'voice' },
      { type: 'image' as const, data: 'encoded', mimeType: 'image/png' },
    ];
    actions.sendUserMessage(content, { deliverAs: 'steer' });
    await vi.waitFor(() =>
      expect(runtime.submitInternalMessage).toHaveBeenCalledWith(
        { role: 'user', content, timestamp: expect.any(Number) },
        'steer',
      ),
    );
    expect(runtime.followUp).not.toHaveBeenCalled();
    actions.sendUserMessage('queued', { deliverAs: 'followUp' });
    await vi.waitFor(() =>
      expect(runtime.submitInternalMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'user', content: 'queued' }),
        'followUp',
      ),
    );
    actions.sendUserMessage('plain');
    await vi.waitFor(() =>
      expect(runtime.submitInternalMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'user', content: 'plain' }),
        'followUp',
      ),
    );
    actions.sendUserMessage('/profile selected', { deliverAs: 'followUp', expandPromptTemplates: true });
    await vi.waitFor(() => expect(runtime.dispatchCommand).toHaveBeenCalledWith('/profile selected'));
    expect(runtime.submitInternalMessage).toHaveBeenCalledTimes(3);
    await emit({ type: 'run_start', lane: 'main', operationId: 'op', runId: 'run', startedAt: Date.now() } as never);
    actions.sendMessage({ customType: 'notice', content: 'custom', display: true }, { deliverAs: 'steer' });
    await vi.waitFor(() =>
      expect(runtime.submitInternalMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'custom', content: 'custom' }),
        'steer',
      ),
    );
    expect(runtime.submitUserPrompt).not.toHaveBeenCalled();
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
    expect(runtime.followUp).not.toHaveBeenCalled();
    expect(runtime.steer).not.toHaveBeenCalled();
  });

  it('defaults streaming custom messages to steer and honors explicit followUp', async () => {
    const { actions, runtime, emit } = await loadedHost([]);
    await emit({ type: 'run_start', lane: 'main', runId: 'run-1', startedAt: CREATED_AT });
    actions.sendMessage({ customType: 'notice', content: 'default', display: true });
    actions.sendMessage({ customType: 'notice', content: 'follow-up', display: true }, { deliverAs: 'followUp' });
    await vi.waitFor(() => expect(runtime.submitInternalMessage).toHaveBeenCalledTimes(2));
    expect(runtime.submitInternalMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ content: 'default' }),
      'steer',
    );
    expect(runtime.submitInternalMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: 'follow-up' }),
      'followUp',
    );
  });

  it.each([
    [false, undefined],
    [false, false],
    [false, true],
    [true, undefined],
    [true, false],
    [true, true],
  ] as const)('forwards nextTurn unchanged (streaming=%s, triggerTurn=%s)', async (streaming, triggerTurn) => {
    const { actions, runtime, emit } = await loadedHost([]);
    if (streaming) await emit({ type: 'run_start', lane: 'main', runId: 'run-1', startedAt: CREATED_AT });
    actions.sendMessage(
      { customType: 'notice', content: 'staged', display: true },
      { deliverAs: 'nextTurn', ...(triggerTurn === undefined ? {} : { triggerTurn }) },
    );
    await vi.waitFor(() => expect(runtime.submitInternalMessage).toHaveBeenCalledTimes(1));
    expect(runtime.submitInternalMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'custom', customType: 'notice', content: 'staged', display: true }),
      'nextTurn',
    );
    expect(runtime.appendMessage).not.toHaveBeenCalled();
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
    expect(runtime.submitUserPrompt).not.toHaveBeenCalled();
  });

  it('appends non-nextTurn custom messages when triggerTurn is false', async () => {
    const { actions, runtime, emit } = await loadedHost([]);
    await emit({ type: 'run_start', lane: 'main', runId: 'run-1', startedAt: CREATED_AT });
    actions.sendMessage(
      { customType: 'notice', content: 'append-only', display: true },
      { deliverAs: 'followUp', triggerTurn: false },
    );
    await vi.waitFor(() => expect(runtime.appendMessage).toHaveBeenCalledTimes(1));
    expect(runtime.submitInternalMessage).not.toHaveBeenCalled();
  });

  it('rejects streaming user messages without an explicit delivery mode', async () => {
    const notice = vi.fn();
    const { actions, runtime, emit } = await loadedHost([], undefined, new Map(), notice);
    await emit({ type: 'run_start', lane: 'main', runId: 'run-1', startedAt: CREATED_AT });
    actions.sendUserMessage('ambiguous');
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith(expect.stringContaining('deliverAs')));
    expect(runtime.submitInternalMessage).not.toHaveBeenCalled();
  });

  it('exposes every registered tool until a restriction narrows the set', async () => {
    const { host, actions } = await loadedHost(['alpha', 'beta']);

    expect(host.tools.map((tool) => tool.name)).toEqual(['alpha', 'beta']);
    expect(actions.getActiveTools()).toEqual(['alpha', 'beta']);
  });

  // setActiveTools used to throw, which left every DoomToolRestriction inert and leaked mode-gated
  // tools such as narrate into sessions whose minor mode was off.
  it('hides a tool and its prompt guidance once setActiveTools drops it', async () => {
    const onActiveToolsChanged = vi.fn();
    const { host, actions } = await loadedHost(['alpha', 'beta'], onActiveToolsChanged);

    actions.setActiveTools(['alpha']);

    expect(host.tools.map((tool) => tool.name)).toEqual(['alpha']);
    expect(host.toolGuidance.map((entry) => entry.name)).toEqual(['alpha']);
    expect(actions.getActiveTools()).toEqual(['alpha']);
    expect(onActiveToolsChanged).toHaveBeenCalledTimes(1);
  });

  // refreshTools used to replace the runtime tools with Pi tools alone, dropping every facet tool.
  it('rebuilds the merged surface on refreshTools instead of replacing runtime tools', async () => {
    const onActiveToolsChanged = vi.fn();
    const { actions } = await loadedHost(['alpha'], onActiveToolsChanged);

    actions.refreshTools();

    expect(onActiveToolsChanged).toHaveBeenCalledTimes(1);
  });

  // Extensions reset their tools in session_shutdown, after the session runtime is disposed.
  it('stops asking for tool rebuilds once shutdown begins', async () => {
    const onActiveToolsChanged = vi.fn();
    const { host, actions } = await loadedHost(['alpha', 'beta'], onActiveToolsChanged);

    await host.shutdown();
    actions.setActiveTools(['alpha']);
    actions.refreshTools();

    expect(actions.getActiveTools()).toEqual(['alpha']);
    expect(onActiveToolsChanged).not.toHaveBeenCalled();
  });

  it('restores a tool when the restriction releases it', async () => {
    const { host, actions } = await loadedHost(['alpha', 'beta']);

    actions.setActiveTools([]);
    expect(host.tools).toEqual([]);
    expect(host.toolGuidance).toEqual([]);

    actions.setActiveTools(['alpha', 'beta']);
    expect(host.tools.map((tool) => tool.name)).toEqual(['alpha', 'beta']);
  });

  it('drops a name the host never registered rather than resurrecting it', async () => {
    const { host, actions } = await loadedHost(['alpha']);

    actions.setActiveTools(['alpha', 'ghost']);

    expect(host.tools.map((tool) => tool.name)).toEqual(['alpha']);
  });

  // The Doom Cordis host opens its session from this event, and
  // DOOM_TOOL_SURFACE_SERVICE is provided there. Without the emit every
  // DoomToolRestriction stayed inert on this runtime, so mode-gated tools such
  // as narrate and plan mode's excluded write stayed active.
  it('starts the Pi session so extension restrictions can take effect', async () => {
    const started = vi.fn();
    await loadedHost(['alpha'], undefined, new Map([['session_start', [started]]]));

    expect(started).toHaveBeenCalledTimes(1);
    expect(started.mock.calls[0]?.[0]).toMatchObject({ type: 'session_start', reason: 'startup' });
  });

  // Admission, not visibility. The harness keeps the list it was last given, so
  // a dropped name stays dispatchable until the next replaceTools. The facet
  // path refuses the same way.
  it('refuses a captured tool whose name left the active set', async () => {
    const { host, actions } = await loadedHost(['alpha', 'beta']);
    const beta = host.tools.find((tool) => tool.name === 'beta')!;

    actions.setActiveTools(['alpha']);

    await expect(
      beta.execute(
        'call-1',
        {},
        () => {},
        undefined as never,
        undefined as never,
        {
          abortSignal: undefined,
        } as never,
      ),
    ).rejects.toThrow("Tool 'beta' is no longer active");
  });
});

function messageEntry(id: string, message: AgentMessage, parentId: string | null = null): Entry {
  return { id, parentId, seq: 1, timestamp: CREATED_AT, type: 'message', message };
}

describe('Pi lifecycle events in the headless host', () => {
  it('dispatches agent, turn, message and tool events in Pi order without rereading history', async () => {
    const seen: string[] = [];
    const branchAtTurnEnd: string[][] = [];
    const turnEndBoundaries: Array<{
      messageEntryId: string;
      toolResultEntryIds: string[];
      outcome: string;
      contextMessages: AgentMessage[];
      canContinue: boolean;
    }> = [];
    const handlers = new Map<string, unknown>();
    for (const type of [
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
      'turn_end',
      'agent_end',
      'agent_settled',
    ]) {
      handlers.set(type, [
        vi.fn((event: { type: string; [key: string]: unknown }, context: { sessionManager: SessionManager }) => {
          seen.push(event.type);
          if (event.type === 'turn_end') {
            branchAtTurnEnd.push(context.sessionManager.getBranch().map((entry) => entry.id));
            if (
              typeof event.messageEntryId === 'string' &&
              Array.isArray(event.toolResultEntryIds) &&
              typeof event.outcome === 'string' &&
              typeof event.context === 'object' &&
              event.context !== null &&
              'contextMessages' in event.context &&
              'canContinue' in event.context &&
              Array.isArray(event.context.contextMessages) &&
              event.context.contextMessages.every((message) => typeof message === 'object' && message !== null) &&
              typeof event.context.canContinue === 'boolean'
            ) {
              turnEndBoundaries.push({
                messageEntryId: event.messageEntryId,
                toolResultEntryIds: event.toolResultEntryIds.filter(
                  (entryId): entryId is string => typeof entryId === 'string',
                ),
                outcome: event.outcome,
                contextMessages: event.context.contextMessages,
                canContinue: event.context.canContinue,
              });
            }
          }
        }),
      ]);
    }
    const { emit, readEntries } = await loadedHost([], undefined, handlers);
    const user: Extract<AgentMessage, { role: 'user' }> = {
      role: 'user',
      content: 'hello',
      timestamp: CREATED_AT,
    };
    const assistant: Extract<AgentMessage, { role: 'assistant' }> = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: CREATED_AT,
    };

    await emit({ type: 'run_start', lane: 'main', runId: 'run-1', startedAt: CREATED_AT });
    await emit({ type: 'turn_start', lane: 'main', runId: 'run-1', turnId: 'turn-1' });
    await emit({ type: 'message_start', lane: 'main', runId: 'run-1', message: user });
    await emit({ type: 'message_end', lane: 'main', runId: 'run-1', message: user, entryId: 'user-1' });
    await emit({ type: 'entry_added', lane: 'main', entry: messageEntry('user-1', user) });
    await emit({
      type: 'tool_start',
      lane: 'main',
      runId: 'run-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'README.md' },
    });
    await emit({
      type: 'tool_update',
      lane: 'main',
      runId: 'run-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      toolName: 'read',
      partialResult: { content: [{ type: 'text', text: 'partial' }], details: undefined },
    });
    await emit({
      type: 'tool_end',
      lane: 'main',
      runId: 'run-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'complete' }], details: undefined },
      isError: false,
      terminate: false,
    });
    await emit({ type: 'message_start', lane: 'main', runId: 'run-1', message: assistant });
    await emit({ type: 'message_end', lane: 'main', runId: 'run-1', message: assistant, entryId: 'assistant-1' });
    await emit({
      type: 'entry_added',
      lane: 'main',
      entry: messageEntry('assistant-1', assistant, 'user-1'),
    });
    await emit({
      type: 'turn_end',
      lane: 'main',
      runId: 'run-1',
      turnId: 'turn-1',
      message: assistant,
      toolResults: [],
    });
    await emit({
      type: 'run_end',
      lane: 'main',
      runId: 'run-1',
      fromTipId: null,
      tipId: 'assistant-1',
      endedAt: CREATED_AT,
      status: 'completed',
    });

    expect(seen).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
      'message_start',
      'message_end',
      'turn_end',
      'agent_end',
      'agent_settled',
    ]);
    expect(branchAtTurnEnd).toEqual([['user-1', 'assistant-1']]);
    expect(turnEndBoundaries).toEqual([
      {
        messageEntryId: 'assistant-1',
        toolResultEntryIds: [],
        outcome: 'completed',
        contextMessages: [user, assistant],
        canContinue: false,
      },
    ]);
    expect(readEntries).toHaveBeenCalledTimes(1);
  });

  it('refreshes checkpoint entries before context hooks without duplicating mirrored state', async () => {
    let manager: SessionManager | undefined;
    const hook = vi.fn((_event: unknown, context: { sessionManager: SessionManager }) => {
      manager = context.sessionManager;
    });
    const { host, readEntries } = await loadedHost([], undefined, new Map([['context', [hook]]]));
    const readOriginal = readEntries.getMockImplementation()!;
    const checkpoint: Entry = {
      id: 'checkpoint',
      parentId: null,
      seq: 1,
      timestamp: CREATED_AT,
      type: 'message',
      message: {
        role: 'custom',
        customType: 'fixture-checkpoint',
        content: 'summary',
        display: false,
        details: { requestId: 'checkpoint-1' },
        timestamp: CREATED_AT,
      },
    };
    try {
      // The native commit is visible even while journal event publication is still pending.
      readEntries.mockResolvedValue({ entries: [checkpoint], leafId: checkpoint.id });
      await host.transformContext([]);
      expect(manager!.getBranch()).toContainEqual(
        expect.objectContaining({ type: 'custom_message', customType: 'fixture-checkpoint' }),
      );
      manager!.appendCustomEntry('fixture-state', { ready: true });
      await vi.waitFor(async () => expect((await readOriginal()).entries).toHaveLength(1));
      const mirrored = (await readOriginal()).entries as Entry[];
      readEntries.mockResolvedValue({ entries: [checkpoint, ...mirrored], leafId: mirrored[0]!.id });
      await host.transformContext([]);
      await host.transformContext([]);
      expect(
        manager!.getBranch().filter((entry) => entry.type === 'custom' && entry.customType === 'fixture-state'),
      ).toHaveLength(1);
    } finally {
      await host.shutdown();
    }
  });
  it('applies custom context checkpoints to real durable model input', async () => {
    const model: Model<Api> = {
      id: 'fixture',
      name: 'Fixture',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'http://localhost',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 65536,
      maxTokens: 256,
    };
    const inputs: unknown[] = [];
    const answer = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'done' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: 'stop' as const,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: CREATED_AT,
    };
    const models = {
      getModels: () => [model],
      getAvailable: async () => [model],
      getModel: () => model,
      streamSimple: (_model: unknown, input: unknown) => {
        inputs.push(input);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'start', partial: answer });
        stream.push({ type: 'done', reason: 'stop', message: answer });
        stream.end();
        return stream;
      },
      complete: vi.fn(),
    } as unknown as Models;
    const contextHook = vi.fn((event: { messages: AgentMessage[] }) => {
      const index = event.messages.findLastIndex(
        (message) =>
          message.role === 'custom' &&
          message.customType === 'fixture-checkpoint' &&
          typeof message.details === 'object' &&
          message.details !== null &&
          'requestId' in message.details &&
          message.details.requestId === 'checkpoint-1',
      );
      if (index < 0) return undefined;
      return {
        messages: [
          { role: 'compactionSummary', summary: 'compact summary', tokensBefore: 100, timestamp: CREATED_AT },
          ...event.messages.slice(index + 1),
        ],
      };
    });
    const preload: LoadExtensionsResult = {
      extensions: [stubExtension([], new Map([['context', [contextHook]]]))],
      errors: [],
      runtime: createExtensionRuntime(),
    };
    let host: ReturnType<typeof createPiExtensionHost> | undefined;
    const runtime = await createDirectHarnessRuntime({
      cwd: temporaryRoot(),
      durableStorage: new MemoryStorage(),
      models,
      model,
      compaction: { enabled: false },
      transformContext: async (event) => ({ messages: await host!.transformContext(event.messages) }),
    });
    initTheme(undefined, false);
    host = createPiExtensionHost({
      cwd: '/tmp',
      agentDir: '/tmp/.pi',
      models: models as unknown as ModelRuntime,
      settings: SettingsManager.inMemory(),
      runtime,
      preload,
      getModel: () => model,
      getThinkingLevel: () => 'off',
      client: () => undefined,
    });
    try {
      await host.load();
      await runtime.prompt('obsolete history');
      await runtime.appendMessage({
        role: 'custom',
        customType: 'fixture-checkpoint',
        content: 'checkpoint content',
        display: false,
        details: { requestId: 'checkpoint-1' },
        timestamp: CREATED_AT,
      });
      await runtime.prompt('continue');
      expect(contextHook).toHaveBeenCalledTimes(2);
      const branch = (
        contextHook.mock.calls[1] as unknown as [unknown, { sessionManager: SessionManager }]
      )[1].sessionManager.getBranch();
      expect(branch).toContainEqual(
        expect.objectContaining({ type: 'custom_message', customType: 'fixture-checkpoint' }),
      );
      expect(JSON.stringify(inputs.at(-1))).toContain('compact summary');
      expect(JSON.stringify(inputs.at(-1))).toContain('continue');
      expect(JSON.stringify(inputs.at(-1))).not.toContain('obsolete history');
      expect(JSON.stringify(inputs.at(-1))).not.toContain('checkpoint content');
    } finally {
      await host.shutdown();
      await runtime.dispose();
    }
  });

  it('resolves turn boundaries against persisted entries when event messages are different objects', async () => {
    const turnEnd = vi.fn();
    const notices = vi.fn();
    const stub = stubRuntime([]);
    const preload: LoadExtensionsResult = {
      extensions: [stubExtension([], new Map([['turn_end', [turnEnd]]]))],
      errors: [],
      runtime: createExtensionRuntime(),
    };
    initTheme(undefined, false);
    const host = createPiExtensionHost({
      cwd: '/workspace/project',
      agentDir: '/workspace/project/.pi',
      models: {} as unknown as ConstructorParameters<typeof ModelRegistry>[0],
      settings: SettingsManager.inMemory(),
      runtime: stub.runtime,
      preload,
      getModel: () => undefined,
      getThinkingLevel: () => 'off',
      client: () => undefined,
      onNotice: notices,
    });
    await host.load();
    const assistant: Extract<AgentMessage, { role: 'assistant' }> = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: CREATED_AT,
    };
    const toolResult: Extract<AgentMessage, { role: 'toolResult' }> = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: CREATED_AT,
    };
    await stub.emit({ type: 'entry_added', lane: 'main', entry: messageEntry('assistant-1', { ...assistant }) });
    await stub.emit({
      type: 'entry_added',
      lane: 'main',
      entry: messageEntry('tool-1', { ...toolResult }, 'assistant-1'),
    });
    await stub.emit({
      type: 'turn_end',
      lane: 'main',
      runId: 'run-1',
      turnId: 'turn-1',
      message: assistant,
      toolResults: [toolResult],
    });

    expect(turnEnd).toHaveBeenCalledWith(
      expect.objectContaining({ messageEntryId: 'assistant-1', toolResultEntryIds: ['tool-1'] }),
      expect.anything(),
    );
    expect(notices).not.toHaveBeenCalled();
    expect(stub.readEntries).toHaveBeenCalledTimes(1);

    // An old branch assistant and tool result must never satisfy a later turn.
    await stub.emit({ type: 'turn_start', lane: 'main', runId: 'run-1', turnId: 'turn-2' });
    await stub.emit({
      type: 'turn_end',
      lane: 'main',
      runId: 'run-1',
      turnId: 'turn-2',
      message: assistant,
      toolResults: [],
    });
    expect(turnEnd).toHaveBeenCalledTimes(1);
    await stub.emit({ type: 'turn_start', lane: 'main', runId: 'run-1', turnId: 'turn-3' });
    await stub.emit({
      type: 'entry_added',
      lane: 'main',
      entry: messageEntry('assistant-2', { ...assistant }, 'tool-1'),
    });
    await stub.emit({
      type: 'turn_end',
      lane: 'main',
      runId: 'run-1',
      turnId: 'turn-3',
      message: assistant,
      toolResults: [toolResult],
    });
    expect(turnEnd).toHaveBeenCalledTimes(1);
    expect(notices).toHaveBeenCalledTimes(2);
    for (const stopReason of ['stop', 'error', 'aborted'] as const) {
      await stub.emit({ type: 'turn_start', lane: 'main', runId: 'run-1', turnId: stopReason });
      const message = { ...assistant, stopReason };
      await stub.emit({ type: 'entry_added', lane: 'main', entry: messageEntry(stopReason, { ...message }) });
      await stub.emit({ type: 'turn_end', lane: 'main', runId: 'run-1', turnId: stopReason, message, toolResults: [] });
      expect(turnEnd).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messageEntryId: stopReason,
          outcome: stopReason === 'stop' ? 'completed' : stopReason,
        }),
        expect.anything(),
      );
    }
    turnEnd.mockClear();
    await host.shutdown();

    const model: Model<Api> = {
      id: 'claude',
      name: 'Fixture',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'http://localhost',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 65536,
      maxTokens: 256,
    };
    const answers = [
      {
        ...assistant,
        stopReason: 'toolUse' as const,
        content: [{ type: 'toolCall' as const, id: 'live-call', name: 'fixture', arguments: {} }],
      },
      { ...assistant, stopReason: 'stop' as const, content: [{ type: 'text' as const, text: 'first' }] },
      { ...assistant, stopReason: 'stop' as const, content: [{ type: 'text' as const, text: 'second' }] },
    ];
    const models = {
      getModels: () => [model],
      getAvailable: async () => [model],
      getModel: () => model,
      streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        const answer = answers.shift()!;
        stream.push({ type: 'start', partial: answer });
        stream.push({ type: 'done', reason: answer.stopReason, message: answer });
        stream.end();
        return stream;
      },
      complete: vi.fn(),
    } as unknown as Models;
    const runtime = await createDirectHarnessRuntime({
      cwd: temporaryRoot(),
      durableStorage: new MemoryStorage(),
      models,
      model,
      compaction: { enabled: false },
      tools: [
        { name: 'fixture', description: 'test', parameters: Type.Object({}), execute: async () => ({ content: [] }) },
      ],
    });
    const liveHost = createPiExtensionHost({
      cwd: '/tmp',
      agentDir: '/tmp/.pi',
      models: models as unknown as ConstructorParameters<typeof ModelRegistry>[0],
      settings: SettingsManager.inMemory(),
      runtime,
      preload,
      getModel: () => model,
      getThinkingLevel: () => 'off',
      client: () => undefined,
    });
    try {
      await liveHost.load();
      await runtime.prompt('question');
      await runtime.prompt('another question');
      const entries = (await runtime.readEntries()).entries;
      const assistants = entries.filter((entry) => entry.type === 'message' && entry.message.role === 'assistant');
      const result = entries.find((entry) => entry.type === 'message' && entry.message.role === 'toolResult');
      expect(turnEnd).toHaveBeenCalledTimes(3);
      for (const [index, entry] of assistants.entries()) {
        expect(turnEnd.mock.calls[index]?.[0]).toMatchObject({
          messageEntryId: entry.id,
          toolResultEntryIds: index === 0 ? [result?.id] : [],
          outcome: 'completed',
        });
      }
    } finally {
      await liveHost.shutdown();
      await runtime.dispose();
    }
  });

  it('dispatches navigation, session metadata and compaction lifecycle events', async () => {
    const tree = vi.fn();
    const info = vi.fn();
    const failed = vi.fn();
    const compacted = vi.fn();
    const handlers = new Map<string, unknown>([
      ['session_tree', [tree]],
      ['session_info_changed', [info]],
      ['session_compact_failed', [failed]],
      ['session_compact', [compacted]],
    ]);
    const { emit, readEntries } = await loadedHost([], undefined, handlers);
    const user = { role: 'user', content: 'hello', timestamp: CREATED_AT } as const;

    await emit({ type: 'entry_added', lane: 'main', entry: messageEntry('user-1', user) });
    await emit({
      type: 'navigation_start',
      lane: 'main',
      runId: 'navigation-1',
      targetId: 'user-1',
      startedAt: CREATED_AT,
    });
    await emit({
      type: 'navigation_end',
      lane: 'main',
      runId: 'navigation-1',
      fromTipId: null,
      tipId: 'user-1',
      endedAt: CREATED_AT,
      status: 'completed',
    });
    await emit({ type: 'value_update', value: 'session_name', name: 'Lifecycle session' });
    await emit({
      type: 'compaction_start',
      lane: 'main',
      runId: 'compact-1',
      reason: 'manual',
      startedAt: CREATED_AT,
    });
    await emit({
      type: 'compaction_end',
      lane: 'main',
      runId: 'compact-1',
      reason: 'manual',
      endedAt: CREATED_AT,
      status: 'aborted',
    });
    const compaction: Extract<Entry, { type: 'compaction' }> = {
      type: 'compaction',
      id: 'compaction-1',
      parentId: 'user-1',
      seq: 2,
      timestamp: CREATED_AT,
      summary: 'older context',
      retainedTail: [user],
      tokensBefore: 100,
      fromHook: false,
    };
    await emit({ type: 'entry_added', lane: 'main', entry: compaction });
    await emit({
      type: 'compaction_start',
      lane: 'main',
      runId: 'compact-2',
      reason: 'threshold',
      startedAt: CREATED_AT,
    });
    await emit({
      type: 'compaction_end',
      lane: 'main',
      runId: 'compact-2',
      reason: 'threshold',
      endedAt: CREATED_AT,
      status: 'completed',
      entryId: compaction.id,
    });
    expect(tree).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_tree', newLeafId: 'user-1', oldLeafId: null }),
      expect.objectContaining({ sessionManager: expect.any(SessionManager) }),
    );
    expect(info).toHaveBeenCalledWith({ type: 'session_info_changed', name: 'Lifecycle session' }, expect.anything());
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_compact_failed',
        reason: 'manual',
        aborted: true,
        willRetry: false,
      }),
      expect.anything(),
    );
    expect(compacted).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_compact',
        compactionEntry: expect.objectContaining({ id: compaction.id, firstKeptEntryId: 'user-1' }),
        reason: 'threshold',
        willRetry: false,
      }),
      expect.anything(),
    );
    expect(readEntries).toHaveBeenCalledTimes(2);
  });

  it('preserves one lifecycle and monotonic turn indexes across run suspension', async () => {
    const starts = vi.fn();
    const ends = vi.fn();
    const turns: number[] = [];
    const handlers = new Map<string, unknown>([
      ['agent_start', [starts]],
      ['agent_end', [ends]],
      ['turn_start', [vi.fn((event: { turnIndex: number }) => turns.push(event.turnIndex))]],
    ]);
    const { emit } = await loadedHost([], undefined, handlers);
    const assistant = (text: string): Extract<AgentMessage, { role: 'assistant' }> => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: CREATED_AT,
    });
    const first = assistant('first');
    const second = assistant('second');

    await emit({ type: 'run_start', lane: 'main', runId: 'run-1', startedAt: CREATED_AT });
    await emit({ type: 'turn_start', lane: 'main', runId: 'run-1', turnId: 'turn-1' });
    await emit({ type: 'message_end', lane: 'main', runId: 'run-1', message: first });
    await emit({
      type: 'turn_end',
      lane: 'main',
      runId: 'run-1',
      turnId: 'turn-1',
      message: first,
      toolResults: [],
    });
    await emit({
      type: 'run_suspend',
      lane: 'main',
      runId: 'run-1',
      reason: 'deferred',
      deferred: { id: 'deferred-1' },
      poll: 1,
    } as HarnessEvent);
    await emit({ type: 'run_resume', lane: 'main', runId: 'run-1' });
    await emit({ type: 'turn_start', lane: 'main', runId: 'run-1', turnId: 'turn-2' });
    await emit({ type: 'message_end', lane: 'main', runId: 'run-1', message: second });
    await emit({
      type: 'turn_end',
      lane: 'main',
      runId: 'run-1',
      turnId: 'turn-2',
      message: second,
      toolResults: [],
    });
    await emit({
      type: 'run_end',
      lane: 'main',
      runId: 'run-1',
      fromTipId: null,
      tipId: null,
      endedAt: CREATED_AT,
      status: 'completed',
    });

    expect(starts).toHaveBeenCalledTimes(1);
    expect(turns).toEqual([0, 1]);
    expect(ends).toHaveBeenCalledTimes(1);
    expect(ends.mock.calls[0]?.[0]).toMatchObject({ type: 'agent_end', messages: [first, second] });
  });

  it('keeps successor runs in one logical loop and resets only after settlement', async () => {
    const starts = vi.fn();
    const ends = vi.fn();
    const settled = vi.fn();
    const turns = vi.fn();
    const turnEnds = vi.fn();
    const { emit } = await loadedHost(
      [],
      undefined,
      new Map<string, unknown>([
        ['agent_start', [starts]],
        ['agent_end', [ends]],
        ['agent_settled', [settled]],
        ['turn_start', [turns]],
        ['turn_end', [turnEnds]],
      ]),
    );
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 3; index += 1) {
      const runId = `run-${index}`;
      const message: Extract<AgentMessage, { role: 'assistant' }> = {
        role: 'assistant',
        content: [{ type: 'text', text: runId }],
        timestamp: CREATED_AT,
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude',
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
      messages.push(message);
      await emit({ type: 'run_start', lane: 'main', runId, startedAt: CREATED_AT });
      await emit({ type: 'turn_start', lane: 'main', runId, turnId: runId });
      await emit({ type: 'message_end', lane: 'main', runId, message });
      await emit({
        type: 'entry_added',
        lane: 'main',
        entry: messageEntry(runId, message, index === 0 ? null : `run-${index - 1}`),
      });
      await emit({ type: 'turn_end', lane: 'main', runId, turnId: runId, message, toolResults: [] });
      await emit({
        type: 'run_end',
        lane: 'main',
        runId,
        fromTipId: null,
        tipId: null,
        endedAt: CREATED_AT,
        status: 'completed',
        successorActive: index < 2,
      });
      expect(starts).toHaveBeenCalledTimes(1);
      expect(ends).toHaveBeenCalledTimes(index < 2 ? 0 : 1);
      expect(settled).toHaveBeenCalledTimes(index < 2 ? 0 : 1);
    }
    expect(turns.mock.calls.map(([event]) => event.turnIndex)).toEqual([0, 1, 2]);
    expect(turnEnds.mock.calls.map(([event]) => event.turnIndex)).toEqual([0, 1, 2]);
    expect(ends.mock.calls[0]?.[0]).toEqual({ type: 'agent_end', messages });

    await emit({ type: 'run_start', lane: 'main', runId: 'fresh', startedAt: CREATED_AT });
    await emit({ type: 'turn_start', lane: 'main', runId: 'fresh', turnId: 'fresh' });
    const fresh: AgentMessage = { role: 'user', content: 'fresh', timestamp: CREATED_AT };
    await emit({ type: 'message_end', lane: 'main', runId: 'fresh', message: fresh });
    await emit({
      type: 'run_end',
      lane: 'main',
      runId: 'fresh',
      fromTipId: null,
      tipId: null,
      endedAt: CREATED_AT,
      status: 'completed',
    });
    expect(starts).toHaveBeenCalledTimes(2);
    expect(turns.mock.calls.map(([event]) => event.turnIndex)).toEqual([0, 1, 2, 0]);
    expect(ends).toHaveBeenCalledTimes(2);
    expect(ends.mock.calls[1]?.[0]).toEqual({ type: 'agent_end', messages: [fresh] });
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it('captures and deduplicates history written by session_start handlers', async () => {
    let manager: SessionManager | undefined;
    const handlers = new Map<string, unknown>([
      [
        'session_start',
        [
          vi.fn((_event: unknown, context: { sessionManager: SessionManager }) => {
            manager = context.sessionManager;
            context.sessionManager.appendCustomEntry('startup', { ready: true });
            context.sessionManager.appendModelChange('anthropic', 'claude');
          }),
        ],
      ],
    ]);

    const { emit, appended } = await loadedHost([], undefined, handlers);
    const user: Extract<AgentMessage, { role: 'user' }> = {
      role: 'user',
      content: 'after startup',
      timestamp: CREATED_AT,
    };
    await emit({
      type: 'entry_added',
      lane: 'main',
      entry: messageEntry('user-after-startup', user, 'appended-2'),
    });

    expect(appended.map((entry) => entry.customType)).toEqual(['startup', 'pi.model_change']);
    expect(manager?.getEntries().map((entry) => entry.type)).toEqual(['custom', 'model_change', 'message']);
    expect(manager?.getBranch().map((entry) => entry.type)).toEqual(['custom', 'model_change', 'message']);
  });
});
