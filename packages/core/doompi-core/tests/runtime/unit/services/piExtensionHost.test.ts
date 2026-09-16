import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentMessage, Entry, HarnessEvent } from '@earendil-works/pi-agent-core';
import type { Extension, LoadExtensionsResult, RegisteredTool, SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  createExtensionRuntime,
  ExtensionRunner,
  initTheme,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBridgedSessionManager,
  createPiExtensionHost,
  resolvePiExtensionEntries,
} from '../../../../src/services/piExtensionHost';
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
  readEntries: ReturnType<typeof vi.fn>;
}

function stubRuntime(entries: Entry[], options?: { parentSessionId?: string; failWrites?: boolean }): StubRuntime {
  const appended: { customType: string; data: unknown }[] = [];
  let nextEntryId = 1;
  let listener: ((event: HarnessEvent, context: never) => void | Promise<void>) | undefined;
  const readEntries = vi.fn(async () => ({ entries, leafId: entries.at(-1)?.id ?? null }));
  const runtime = {
    session: {
      metadata: {
        id: 'session-1',
        createdAt: CREATED_AT,
        storageVersion: 1,
        cwd: '/workspace/project',
        ...(options?.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
      },
    },
    readEntries,
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

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
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
) {
  const stub = stubRuntime([]);
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
    runtime: stub.runtime,
    preload,
    getModel: () => undefined,
    getThinkingLevel: () => 'off',
    client: () => undefined,
    ...(onActiveToolsChanged === undefined ? {} : { onActiveToolsChanged }),
  });
  await host.load();
  // bindCore copies the host's actions onto the shared runtime, which is the object every
  // extension's ExtensionAPI calls through. Reaching it here exercises the real seam.
  return {
    host,
    actions: preload.runtime,
    emit: stub.emit,
    readEntries: stub.readEntries,
    appended: stub.appended,
  };
}

describe('Pi extension tool surface in the headless host', () => {
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
        vi.fn((event: { type: string }, context: { sessionManager: SessionManager }) => {
          seen.push(event.type);
          if (event.type === 'turn_end')
            branchAtTurnEnd.push(context.sessionManager.getBranch().map((entry) => entry.id));
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
    expect(readEntries).toHaveBeenCalledTimes(1);
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
