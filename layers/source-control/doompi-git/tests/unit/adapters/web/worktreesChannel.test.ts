import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktreesChannel } from '../../../../src/controllers/worktreesChannel';
import { registryFile } from '../../../../src/services/paths';
import { DoomGitExpectedError } from '../../../../src/services/errors';
import type {
  DoomDirectEventBus,
  DoomHubChannelHost,
  DoomHubChannelSource,
} from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { GIT_WORKTREE_LIFECYCLE_EVENT } from '../../../../src/services/worktreeEvents';
import type { WorktreeOperations } from '../../../../src/services/worktreeOperations';
import { WORKTREE_RECORD_VERSION, type WorktreeRecord } from '../../../../src/types/worktreeRegistry';

let home: string;
let repository: string;

const OWNER = { sessionId: 'parent-1', cwd: '' };
const STRANGER = { sessionId: 'parent-2', cwd: '' };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-chan-'));
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-chan-repo-'));
  OWNER.cwd = repository;
  STRANGER.cwd = repository;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repository, { recursive: true, force: true });
});

function record(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    version: WORKTREE_RECORD_VERSION,
    id: 'wt1',
    branch: 'wt/one',
    baseRef: 'main',
    path: path.join(home, 'worktrees', 'wt1'),
    repositoryRoot: repository,
    sessionId: 'child-1',
    parentSessionId: 'parent-1',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function seed(...entries: WorktreeRecord[]): void {
  const file = registryFile(repository, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: WORKTREE_RECORD_VERSION, entries }));
}

interface Published {
  sessionId: string;
  payload: { worktrees: { id: string; unowned: boolean }[]; pending?: string; error?: string };
}

function fakeHost(
  published: Published[],
  live: readonly string[],
  directEvents: DoomDirectEventBus,
): DoomHubChannelHost {
  return {
    sessions: () => [],
    sessionService: {
      create: vi.fn(),
      close: vi.fn(),
      isLive: (sessionId) => live.includes(sessionId),
    },
    directEvents,
    publish: (sessionId, payload) => {
      published.push({ sessionId, payload: payload as Published['payload'] });
    },
    requestSessionApi: vi.fn(),
    onNotice: vi.fn(),
  };
}
function directEvents(): {
  bus: DoomDirectEventBus;
  emit(frameType: string, sessionId: string, payload: unknown): void;
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const key = (frameType: string, sessionId: string): string => `${frameType}:${sessionId}`;
  const bus: DoomDirectEventBus = {
    publish(frameType, sessionId, payload) {
      for (const listener of listeners.get(key(frameType, sessionId)) ?? []) listener(payload);
    },
    subscribe(frameType, sessionId, listener) {
      const current = listeners.get(key(frameType, sessionId)) ?? new Set<(payload: unknown) => void>();
      current.add(listener);
      listeners.set(key(frameType, sessionId), current);
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(key(frameType, sessionId));
      };
    },
    close: () => listeners.clear(),
  };
  return { bus, emit: (frameType, sessionId, payload) => bus.publish(frameType, sessionId, payload) };
}

function fakeOperations(overrides: Partial<WorktreeOperations> = {}): WorktreeOperations {
  return {
    spawn: vi.fn().mockResolvedValue(record()),
    close: vi.fn().mockResolvedValue(record()),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn(),
    merge: vi.fn(),
    prune: vi.fn(),
    send: vi.fn(),
    messages: vi.fn(),
    ...overrides,
  } as unknown as WorktreeOperations;
}

function start(
  published: Published[],
  operations: WorktreeOperations,
  live: readonly string[] = ['parent-1', 'parent-2'],
  events: DoomDirectEventBus = directEvents().bus,
) {
  const channel = createWorktreesChannel({ operations, homeDir: home });
  const source: DoomHubChannelSource = channel.start(fakeHost(published, live, events));
  return { channel, source };
}

/** Lets the promise chain inside receive settle before the assertions run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('what a session is shown', () => {
  it('shows a session its own worktrees', () => {
    seed(record());
    const published: Published[] = [];
    const { source } = start(published, fakeOperations());

    source.sessionAdded?.(OWNER);

    expect(published.at(-1)?.payload.worktrees.map((entry) => entry.id)).toEqual(['wt1']);
  });

  /** The leak this guard closes: another session's work in progress is not this session's business. */
  it('hides a worktree owned by a different live session', () => {
    seed(record());
    const published: Published[] = [];
    const { source } = start(published, fakeOperations());

    source.sessionAdded?.(STRANGER);

    expect(published.at(-1)?.payload.worktrees).toEqual([]);
  });

  /** Without this, a worktree outliving its parent would be invisible to everyone and closable by nobody. */
  it('shows a worktree whose parent session is gone, marked unowned', () => {
    seed(record());
    const published: Published[] = [];
    const { source } = start(published, fakeOperations(), ['parent-2']);

    source.sessionAdded?.(STRANGER);

    expect(published.at(-1)?.payload.worktrees).toEqual([expect.objectContaining({ id: 'wt1', unowned: true })]);
  });

  it('treats an unreadable registry as an empty list', () => {
    const published: Published[] = [];
    const { source } = start(published, fakeOperations());

    source.sessionAdded?.(OWNER);

    expect(published.at(-1)?.payload.worktrees).toEqual([]);
  });
});
describe('direct lifecycle events', () => {
  it('refreshes durable registry state without polling', () => {
    const published: Published[] = [];
    const events = directEvents();
    const { source } = start(published, fakeOperations(), ['parent-1'], events.bus);

    source.sessionAdded?.(OWNER);
    expect(published.at(-1)?.payload.worktrees).toEqual([]);
    seed(record());
    events.emit(GIT_WORKTREE_LIFECYCLE_EVENT, OWNER.sessionId, { version: 1, repositoryRoot: repository });

    expect(published.at(-1)?.payload.worktrees.map((entry) => entry.id)).toEqual(['wt1']);
    const count = published.length;
    events.emit(GIT_WORKTREE_LIFECYCLE_EVENT, OWNER.sessionId, { version: 0, repositoryRoot: repository });
    events.emit(GIT_WORKTREE_LIFECYCLE_EVENT, OWNER.sessionId, null);
    events.emit(GIT_WORKTREE_LIFECYCLE_EVENT, OWNER.sessionId, { version: 1, repositoryRoot: '' });
    expect(published).toHaveLength(count);
    source.sessionRemoved?.(OWNER.sessionId);
    events.emit(GIT_WORKTREE_LIFECYCLE_EVENT, OWNER.sessionId, { version: 1, repositoryRoot: repository });
    expect(published).toHaveLength(count);
  });
});

describe('commands from the dock', () => {
  it('creates a worktree through the same operations the tool uses', async () => {
    const operations = fakeOperations();
    const published: Published[] = [];
    const { channel, source } = start(published, operations);
    source.sessionAdded?.(OWNER);

    channel.receive?.(OWNER, { action: 'create', branch: 'wt/two', baseRef: 'main' }, { connectionId: 'c1' });
    await settle();

    expect(operations.spawn).toHaveBeenCalledWith(
      { cwd: repository, sessionId: 'parent-1' },
      { branch: 'wt/two', baseRef: 'main' },
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it('closes a worktree', async () => {
    const operations = fakeOperations();
    const published: Published[] = [];
    const { channel, source } = start(published, operations);
    source.sessionAdded?.(OWNER);

    channel.receive?.(OWNER, { action: 'close', id: 'wt1' }, { connectionId: 'c1' });
    await settle();

    expect(operations.close).toHaveBeenCalledWith({ cwd: repository, sessionId: 'parent-1' }, 'wt1', false);
  });

  it('reports the operation while it runs and clears it after', async () => {
    let release: () => void = () => undefined;
    const operations = fakeOperations({
      spawn: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => {
              resolve(record());
            };
          }),
      ) as WorktreeOperations['spawn'],
    });
    const published: Published[] = [];
    const { channel, source } = start(published, operations);
    source.sessionAdded?.(OWNER);

    channel.receive?.(OWNER, { action: 'create', branch: 'wt/two' }, { connectionId: 'c1' });
    await settle();
    expect(published.at(-1)?.payload.pending).toBe('creating wt/two\u2026');

    release();
    await settle();
    expect(published.at(-1)?.payload.pending).toBeUndefined();
  });

  // One frozen label for a wait that runs into minutes reads as a hang. Each
  // phase the operation reports replaces it, so the panel keeps moving.
  it('republishes each phase the spawn reports', async () => {
    let report: (label: string) => void = () => undefined;
    let release: () => void = () => undefined;
    const operations = fakeOperations({
      spawn: vi.fn().mockImplementation(
        (_context: unknown, _request: unknown, options?: { onProgress?: (label: string) => void }) =>
          new Promise((resolve) => {
            report = (label) => options?.onProgress?.(label);
            release = () => {
              resolve(record());
            };
          }),
      ) as WorktreeOperations['spawn'],
    });
    const published: Published[] = [];
    const { channel, source } = start(published, operations);
    source.sessionAdded?.(OWNER);

    channel.receive?.(OWNER, { action: 'create', branch: 'wt/two' }, { connectionId: 'c1' });
    await settle();
    report('starting session\u2026');
    await settle();
    expect(published.at(-1)?.payload.pending).toBe('starting session\u2026');

    release();
    await settle();
    expect(published.at(-1)?.payload.pending).toBeUndefined();
  });
  /** A create runs for minutes; a second click must not start a second worktree behind the first. */
  it('drops a second command while one is in flight', async () => {
    const operations = fakeOperations({
      spawn: vi.fn().mockImplementation(() => new Promise(() => undefined)) as WorktreeOperations['spawn'],
    });
    const published: Published[] = [];
    const { channel, source } = start(published, operations);
    source.sessionAdded?.(OWNER);

    channel.receive?.(OWNER, { action: 'create', branch: 'wt/two' }, { connectionId: 'c1' });
    channel.receive?.(OWNER, { action: 'create', branch: 'wt/three' }, { connectionId: 'c1' });
    await settle();

    expect(operations.spawn).toHaveBeenCalledOnce();
  });

  it('publishes an expected failure in words the reader can act on', async () => {
    const operations = fakeOperations({
      spawn: vi
        .fn()
        .mockRejectedValue(
          new DoomGitExpectedError('worktree_exists', 'Branch wt/two already has a worktree.', false, 'Pick another.'),
        ) as WorktreeOperations['spawn'],
    });
    const published: Published[] = [];
    const { channel, source } = start(published, operations);
    source.sessionAdded?.(OWNER);

    channel.receive?.(OWNER, { action: 'create', branch: 'wt/two' }, { connectionId: 'c1' });
    await settle();

    expect(published.at(-1)?.payload.error).toContain('already has a worktree');
    expect(published.at(-1)?.payload.pending).toBeUndefined();
  });

  /** A git failure can carry a remote URL with a token in it, so an unexpected one is summarised. */
  it('never echoes an unexpected failure', async () => {
    const operations = fakeOperations({
      spawn: vi
        .fn()
        .mockRejectedValue(new Error('fatal: https://user:sekrit@example.com/repo.git')) as WorktreeOperations['spawn'],
    });
    const published: Published[] = [];
    const { channel, source } = start(published, operations);
    source.sessionAdded?.(OWNER);

    channel.receive?.(OWNER, { action: 'create', branch: 'wt/two' }, { connectionId: 'c1' });
    await settle();

    expect(published.at(-1)?.payload.error).toBe('The worktree operation failed.');
    expect(JSON.stringify(published)).not.toContain('sekrit');
  });

  it('ignores a frame that is not a command', async () => {
    const operations = fakeOperations();
    const published: Published[] = [];
    const { channel, source } = start(published, operations);
    source.sessionAdded?.(OWNER);

    channel.receive?.(OWNER, { action: 'create' }, { connectionId: 'c1' });
    channel.receive?.(OWNER, { action: 'nonsense' }, { connectionId: 'c1' });
    channel.receive?.(OWNER, 'not an object', { connectionId: 'c1' });
    await settle();

    expect(operations.spawn).not.toHaveBeenCalled();
    expect(operations.close).not.toHaveBeenCalled();
  });
});
