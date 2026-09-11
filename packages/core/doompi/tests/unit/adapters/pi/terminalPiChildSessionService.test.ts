import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoomChildSessionRequest } from '@agimon-ai/doompi-extension-contracts/child-session';
import type {
  DirectHarnessRuntime,
  DirectHarnessRuntimeOptions,
} from '../../../../src/adapters/server/directHarnessRuntime.ts';
import {
  captureTerminalPiForkSource,
  createTerminalPiChildSessionService,
  type TerminalPiForkSourceManager,
} from '../../../../src/adapters/pi/terminalPiChildSessionService.ts';

const tempRoots: string[] = [];

function request(source: DoomChildSessionRequest['source'], cwd: string): DoomChildSessionRequest {
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

function fakeRuntime(options: DirectHarnessRuntimeOptions): DirectHarnessRuntime {
  const sessionFile = options.sessionPath;
  return {
    sessionId: 'child-session',
    laneName: 'main',
    harnessId: 'child-session',
    session: { metadata: { path: sessionFile } } as unknown as DirectHarnessRuntime['session'],
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

function v3Snapshot(): string {
  return [
    {
      type: 'session',
      version: 3,
      id: 'parent-session',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/workspace',
    },
    {
      type: 'message',
      id: 'parent-leaf',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'parent' }] },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')
    .concat('\n');
}

function manager(branch: readonly Record<string, unknown>[]): TerminalPiForkSourceManager {
  return {
    getSessionId: () => 'parent-session',
    getLeafId: () => 'parent-leaf',
    getHeader: () => ({ type: 'session', version: 3, id: 'parent-session', cwd: '/workspace' }),
    getBranch: () => branch,
  };
}

function owner() {
  const releases: ReturnType<typeof vi.fn>[] = [];
  const ownership = {
    acquire: vi.fn(async () => {
      const release = vi.fn(async () => undefined);
      releases.push(release);
      return { assertQuiescent: vi.fn(), release };
    }),
  };
  return { ownership, releases };
}

beforeEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('terminal Pi child session provider', () => {
  it('captures an immutable selected branch snapshot instead of a live v3 path', () => {
    const entry: Record<string, unknown> = {
      id: 'parent-leaf',
      parentId: null,
      type: 'message',
      message: { role: 'user', content: [] },
    };
    const source = captureTerminalPiForkSource(
      {
        ...manager([entry]),
        getBranch: vi.fn((leafId?: string) => {
          expect(leafId).toBe('tool-safe-leaf');
          return [{ ...entry, id: leafId }];
        }),
      },
      'tool-safe-leaf',
    );

    expect(source).toMatchObject({
      kind: 'terminal-pi-fork',
      sourceSessionId: 'parent-session',
      sourceLeafId: 'tool-safe-leaf',
    });
    expect(source?.snapshotJsonl).toContain('tool-safe-leaf');
    entry.message = { role: 'assistant', content: [{ type: 'text', text: 'changed' }] };
    expect(source?.snapshotJsonl).not.toContain('changed');
  });

  it('imports the snapshot into a separate v4 destination and preserves the v3 parent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-terminal-provider-'));
    tempRoots.push(root);
    const parentPath = path.join(root, 'parent-v3.jsonl');
    const snapshotJsonl = v3Snapshot();
    fs.writeFileSync(parentPath, snapshotJsonl);
    const original = fs.readFileSync(parentPath);
    const { ownership, releases } = owner();
    let runtime: DirectHarnessRuntime | undefined;
    const runtimeFactory = vi.fn(async (options: DirectHarnessRuntimeOptions) => {
      runtime = fakeRuntime(options);
      return runtime;
    });
    const service = createTerminalPiChildSessionService({
      cwd: root,
      sessionsRoot: root,
      historyOwnership: ownership,
      runtimeFactory,
    });

    const handle = await service.start(
      request(
        {
          kind: 'terminal-pi-fork',
          sourceSessionId: 'parent-session',
          sourceLeafId: 'parent-leaf',
          snapshotJsonl,
        },
        root,
      ),
    );
    const options = runtimeFactory.mock.calls[0]?.[0];
    const destination = options?.sessionPath;
    expect(destination).toBeDefined();
    expect(destination).not.toBe(parentPath);
    expect(JSON.parse(fs.readFileSync(destination!, 'utf8').split('\n', 1)[0]!)).toMatchObject({
      kind: 'header',
      v: 4,
    });
    expect(fs.readFileSync(parentPath)).toEqual(original);
    expect(ownership.acquire).toHaveBeenCalledWith(destination);
    expect(ownership.acquire).not.toHaveBeenCalledWith(parentPath);
    expect(releases).toHaveLength(1);
    await handle.dispose();
    await handle.dispose();
    expect(runtime?.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed and v4 terminal snapshots before creating a runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-terminal-provider-reject-'));
    tempRoots.push(root);
    const runtimeFactory = vi.fn(async (options: DirectHarnessRuntimeOptions) => fakeRuntime(options));
    const service = createTerminalPiChildSessionService({ cwd: root, runtimeFactory });
    const base = { kind: 'terminal-pi-fork' as const, sourceSessionId: 'parent-session', sourceLeafId: 'parent-leaf' };

    await expect(service.start(request({ ...base, snapshotJsonl: '{bad\n' }, root))).rejects.toThrow('Malformed');
    await expect(
      service.start(request({ ...base, snapshotJsonl: `${JSON.stringify({ kind: 'header', v: 4 })}\n` }, root)),
    ).rejects.toThrow('v3 JSONL');
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it('rejects incomplete captures and structurally invalid immutable snapshots', async () => {
    const entry = { type: 'message', id: 'leaf', parentId: null };
    expect(captureTerminalPiForkSource({ ...manager([entry]), getSessionId: () => ' ' })).toBeUndefined();
    expect(captureTerminalPiForkSource({ ...manager([entry]), getLeafId: () => null })).toBeUndefined();
    expect(
      captureTerminalPiForkSource({ ...manager([entry]), getHeader: () => ({ type: 'session', version: 2 }) }),
    ).toBeUndefined();
    expect(captureTerminalPiForkSource(manager([{ ...entry, id: 'different' }]))).toBeUndefined();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-terminal-provider-invalid-'));
    tempRoots.push(root);
    const runtimeFactory = vi.fn(async (options: DirectHarnessRuntimeOptions) => fakeRuntime(options));
    const service = createTerminalPiChildSessionService({ cwd: root, sessionsRoot: root, runtimeFactory });
    const base = { kind: 'terminal-pi-fork' as const, sourceSessionId: 'parent-session', sourceLeafId: 'parent-leaf' };
    const header = JSON.stringify({ type: 'session', version: 3, id: 'parent-session' });
    const invalid = [
      { snapshot: header, message: 'truncated' },
      { snapshot: `${header}\n{bad\n`, message: 'record at line 2' },
      { snapshot: `${header}\n[]\n`, message: 'Invalid terminal Pi snapshot record' },
      { snapshot: `${header}\n${JSON.stringify({ id: '', parentId: null })}\n`, message: 'record 2 id' },
      { snapshot: `${header}\n${JSON.stringify({ id: 'parent-leaf', parentId: 1 })}\n`, message: 'parentId' },
      {
        snapshot: `${JSON.stringify({ type: 'session', version: 3, id: 'other' })}\n${JSON.stringify({ id: 'parent-leaf', parentId: null })}\n`,
        message: 'identity does not match',
      },
      {
        snapshot: `${header}\n${JSON.stringify({ id: 'other-leaf', parentId: null })}\n`,
        message: 'leaf does not match',
      },
    ];
    for (const [index, candidate] of invalid.entries()) {
      await expect(service.start(request({ ...base, snapshotJsonl: candidate.snapshot }, root))).rejects.toThrow(
        candidate.message,
      );
      expect(runtimeFactory, `invalid case ${index}`).not.toHaveBeenCalled();
    }
  });

  it('validates a requested terminal model before creating its journal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-terminal-provider-model-'));
    tempRoots.push(root);
    const service = createTerminalPiChildSessionService({ cwd: root, sessionsRoot: root });
    await expect(
      service.start({
        ...request(
          {
            kind: 'terminal-pi-fork',
            sourceSessionId: 'parent-session',
            sourceLeafId: 'parent-leaf',
            snapshotJsonl: v3Snapshot(),
          },
          root,
        ),
        model: 'invalid',
      }),
    ).rejects.toThrow('provider/model');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('delegates fresh and v4 restore sources to the shared headless provider', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-terminal-provider-shared-'));
    tempRoots.push(root);
    const v4Path = path.join(root, 'restore.jsonl');
    fs.writeFileSync(
      v4Path,
      `${JSON.stringify({ kind: 'header', v: 4, id: 'restore', storageVersion: 1, createdAt: Date.now(), cwd: root })}\n`,
    );
    const runtimeFactory = vi.fn(async (options: DirectHarnessRuntimeOptions) => fakeRuntime(options));
    const service = createTerminalPiChildSessionService({ cwd: root, runtimeFactory });

    const fresh = await service.start(request({ kind: 'fresh' }, root));
    const restored = await service.start(request({ kind: 'v4-restore', sessionFile: v4Path }, root));
    expect(runtimeFactory.mock.calls[0]?.[0]).not.toHaveProperty('sessionPath');
    expect(runtimeFactory.mock.calls[1]?.[0].sessionPath).toBe(fs.realpathSync(v4Path));
    await fresh.dispose();
    await restored.dispose();
    await service.close();
    await service.close();
  });
});
