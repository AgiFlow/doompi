import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomDirectEventBus } from '@agimon-ai/doompi-core/hubChannel';
import type { DoomSessionDeliveryService } from '@agimon-ai/doompi-session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HubUnavailableError } from '../../../../src/services/errors';
import {
  createWorktreeMessageInbox,
  GIT_WORKTREE_MESSAGE_EVENT,
  MAX_WORKTREE_INBOX_MESSAGES,
  MAX_WORKTREE_MESSAGE_BYTES,
} from '../../../../src/services/worktreeEvents';
import { createWorktreeOperations } from '../../../../src/services/worktreeOperations';
import { WORKTREE_RECORD_VERSION } from '../../../../src/types/worktreeRegistry';
import type { WorktreeGit, WorktreeRecord } from '../../../../src/types/worktreeRegistry';

let home: string;
let repository: string;

const CONTEXT = { cwd: '/repo', sessionId: 'parent-1' };

function directEvents(): DoomDirectEventBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const key = (frameType: string, sessionId: string): string => `${frameType}:${sessionId}`;
  return {
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
}

function fakeGit(overrides: Partial<WorktreeGit> = {}): WorktreeGit {
  return {
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    pruneWorktrees: vi.fn().mockResolvedValue(undefined),
    listWorktreePaths: vi.fn().mockResolvedValue([]),
    dirtyFiles: vi.fn().mockResolvedValue([]),
    repositoryRoot: vi.fn().mockResolvedValue(repository),
    currentBranch: vi.fn().mockResolvedValue('main'),
    remoteBaseRef: vi.fn().mockResolvedValue('origin/main'),
    mergeBranch: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function fakeSessionService(
  live: readonly string[] = [],
  create = vi.fn().mockResolvedValue({ sessionId: 'session-9', cwd: '/worktree' }),
  close = vi.fn().mockResolvedValue(undefined),
) {
  return { create, close, isLive: (sessionId: string) => live.includes(sessionId) };
}

function fakeDelivery(overrides: Partial<DoomSessionDeliveryService> = {}): DoomSessionDeliveryService {
  return {
    recipientKey: 'parent-1',
    deliver: vi.fn().mockResolvedValue({ deliveryId: 'delivery-1' }),
    waitForAdmission: vi.fn().mockResolvedValue('admitted'),
    inbox: vi.fn().mockReturnValue([]),
    consume: vi.fn().mockReturnValue(true),
    outbox: vi.fn().mockReturnValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
function operations(
  git: WorktreeGit,
  createSession = vi.fn().mockResolvedValue({ sessionId: 'session-9', cwd: '/worktree' }),
) {
  const sessionService = fakeSessionService([], createSession);
  return {
    ops: createWorktreeOperations({ git, sessionService, cleanupStorage: vi.fn(), homeDir: home }),
    createSession,
    sessionService,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-ops-'));
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-repo-'));
  fs.mkdirSync(path.join(repository, '.git'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repository, { recursive: true, force: true });
});

describe('spawn', () => {
  it('does not acquire a registry lock or create Git state without the cockpit lifecycle', async () => {
    const git = fakeGit();
    const mirror = vi.fn();
    const ops = createWorktreeOperations({ git, mirror, homeDir: home });

    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' })).rejects.toMatchObject({
      code: 'hub_unavailable',
      retryable: true,
    });
    expect(fs.readdirSync(home)).toEqual([]);
    expect(git.repositoryRoot).not.toHaveBeenCalled();
    expect(git.addWorktree).not.toHaveBeenCalled();
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
    await expect(ops.list(CONTEXT)).resolves.toEqual([]);
  });

  it('creates the worktree, starts a session, and records both', async () => {
    const git = fakeGit();
    const { ops, createSession } = operations(git);

    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });

    expect(git.addWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryRoot: repository, branch: 'wt/one', baseRef: 'origin/main' }),
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: record.path, parentSessionId: 'parent-1', name: 'wt/one' }),
    );
    expect(record.sessionId).toBe('session-9');
    expect(await ops.list(CONTEXT)).toHaveLength(1);
  });

  it('puts the worktree outside the repository', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    expect(record.path.startsWith(repository)).toBe(false);
    expect(record.path).toContain('.doom/git/worktrees');
  });

  it('uses an explicit baseRef over the remote base', async () => {
    const git = fakeGit();
    const { ops } = operations(git);
    await ops.spawn(CONTEXT, { branch: 'wt/one', baseRef: 'v1.0' });
    expect(git.addWorktree).toHaveBeenCalledWith(expect.objectContaining({ baseRef: 'v1.0' }));
    expect(git.remoteBaseRef).not.toHaveBeenCalled();
  });

  it('refuses to inherit the local branch when no remote base is available', async () => {
    const git = fakeGit({ remoteBaseRef: vi.fn().mockResolvedValue(undefined) });
    const { ops } = operations(git);

    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' })).rejects.toThrow(/No remote base branch is available/u);
    expect(git.currentBranch).not.toHaveBeenCalled();
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it('durably delivers the task after the worktree session is recorded', async () => {
    const delivery = fakeDelivery();
    const ops = createWorktreeOperations({
      git: fakeGit(),
      sessionService: fakeSessionService(),
      sessionDelivery: () => delivery,
      homeDir: home,
    });

    const record = await ops.spawn(CONTEXT, { branch: 'wt/task', task: 'Implement the parser' });

    expect(delivery.deliver).toHaveBeenCalledWith({
      recipientKey: record.sessionId,
      kind: 'git.worktree.delegation',
      prompt: 'Implement the parser',
      metadata: {
        worktreeId: record.id,
        fromRole: 'parent',
        text: 'Implement the parser',
        sentAt: record.createdAt,
      },
    });
    expect(await ops.list(CONTEXT)).toEqual([expect.objectContaining({ id: record.id })]);
  });

  it('keeps a registered worktree manageable when task persistence fails', async () => {
    const git = fakeGit();
    const delivery = fakeDelivery({ deliver: vi.fn().mockRejectedValue(new Error('disk full')) });
    const ops = createWorktreeOperations({
      git,
      sessionService: fakeSessionService(),
      sessionDelivery: () => delivery,
      homeDir: home,
    });

    await expect(ops.spawn(CONTEXT, { branch: 'wt/task', task: 'Implement it' })).rejects.toMatchObject({
      code: 'task_delivery_failed',
      retryable: true,
    });
    expect(await ops.list(CONTEXT)).toHaveLength(1);
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });

  it('reports a task that was persisted but could not be admitted', async () => {
    const delivery = fakeDelivery({ waitForAdmission: vi.fn().mockResolvedValue('recovery_required') });
    const ops = createWorktreeOperations({
      git: fakeGit(),
      sessionService: fakeSessionService(),
      sessionDelivery: () => delivery,
      homeDir: home,
    });

    await expect(ops.spawn(CONTEXT, { branch: 'wt/task', task: 'Implement it' })).rejects.toMatchObject({
      code: 'task_delivery_failed',
      retryable: true,
    });
    expect(await ops.list(CONTEXT)).toHaveLength(1);
  });

  it('reports a task whose admission receipt times out', async () => {
    const delivery = fakeDelivery({ waitForAdmission: vi.fn().mockResolvedValue(undefined) });
    const ops = createWorktreeOperations({
      git: fakeGit(),
      sessionService: fakeSessionService(),
      sessionDelivery: () => delivery,
      homeDir: home,
    });

    await expect(ops.spawn(CONTEXT, { branch: 'wt/task', task: 'Implement it' })).rejects.toMatchObject({
      code: 'task_delivery_failed',
      retryable: true,
    });
  });
  it('refuses a tasked spawn before creating git state when Session delivery is unavailable', async () => {
    const git = fakeGit();
    const { ops } = operations(git);

    await expect(ops.spawn(CONTEXT, { branch: 'wt/task', task: 'Do it' })).rejects.toThrow(
      /Session delivery service is unavailable/u,
    );
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it('refuses a second worktree on one branch', async () => {
    const { ops } = operations(fakeGit());
    await ops.spawn(CONTEXT, { branch: 'wt/one' });
    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' })).rejects.toThrow(/already has a worktree/u);
  });

  it('refuses outside a repository', async () => {
    const git = fakeGit({ repositoryRoot: vi.fn().mockResolvedValue(undefined) });
    const { ops } = operations(git);
    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' })).rejects.toThrow(/not inside a git repository/u);
  });

  // A directory on disk that no record points at is unreachable forever, so a
  // failed session start has to take the worktree with it.
  it('removes the worktree when the session cannot be started, and records nothing', async () => {
    const git = fakeGit();
    const createSession = vi.fn().mockRejectedValue(new HubUnavailableError('No cockpit is running.'));
    const { ops } = operations(git, createSession);

    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' })).rejects.toThrow(/No cockpit is running/u);

    expect(git.removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(git.deleteBranch).toHaveBeenCalledWith({ repositoryRoot: repository, branch: 'wt/one' });
    expect(await ops.list(CONTEXT)).toEqual([]);
  });

  it('reports a missing cockpit as retryable rather than as a git failure', async () => {
    const createSession = vi.fn().mockRejectedValue(new HubUnavailableError('No cockpit is running.'));
    const { ops } = operations(fakeGit(), createSession);
    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' })).rejects.toThrow(/hub_unavailable/u);
  });

  // The branch outlives `worktree remove`, so a rollback that stops there
  // leaves a branch nobody asked for. It is deleted only when git agrees it
  // holds nothing, and the caller is told when it does not.
  it('keeps a branch that holds work, and says so', async () => {
    const git = fakeGit({ deleteBranch: vi.fn().mockResolvedValue(false) });
    const createSession = vi.fn().mockRejectedValue(new HubUnavailableError('No cockpit is running.'));
    const { ops } = operations(git, createSession);

    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' })).rejects.toThrow(
      /branch wt\/one has work on it and was kept/u,
    );
  });

  it('refuses an already cancelled spawn before creating a worktree', async () => {
    const git = fakeGit();
    const createSession = vi.fn();
    const { ops } = operations(git, createSession);

    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' }, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'spawn_cancelled',
    });

    expect(createSession).not.toHaveBeenCalled();
    expect(git.addWorktree).not.toHaveBeenCalled();
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(await ops.list(CONTEXT)).toEqual([]);
  });

  it('reports each phase while it works', async () => {
    const { ops } = operations(fakeGit());
    const labels: string[] = [];

    await ops.spawn(CONTEXT, { branch: 'wt/one' }, { onProgress: (label) => labels.push(label) });

    expect(labels).toEqual(['creating branch wt/one\u2026', 'mirroring build output\u2026', 'starting session\u2026']);
  });

  // The session composes this repository's own packages from build output git
  // does not track. Mirroring after the session starts would be too late.
  it('mirrors the parent checkout into the worktree before the session starts', async () => {
    const order: string[] = [];
    const mirror = vi.fn().mockImplementation(() => {
      order.push('mirror');
      return { kind: 'mirrored', copied: 3, linked: 2 };
    });
    const createSession = vi.fn().mockImplementation(() => {
      order.push('session');
      return Promise.resolve({ sessionId: 'session-9', cwd: '/worktree' });
    });
    const ops = createWorktreeOperations({
      git: fakeGit(),
      sessionService: fakeSessionService([], createSession),
      mirror,
      homeDir: home,
    });

    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });

    expect(mirror).toHaveBeenCalledWith(repository, record.path);
    expect(order).toEqual(['mirror', 'session']);
  });
});

describe('close', () => {
  it('removes a clean worktree and forgets it', async () => {
    const git = fakeGit();
    const { ops } = operations(git);
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });

    await ops.close(CONTEXT, record.id, false);

    expect(git.removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: record.path }));
    expect(await ops.list(CONTEXT)).toEqual([]);
  });

  it('removes generated storage after removing the checkout', async () => {
    const cleanupStorage = vi.fn();
    const git = fakeGit();
    const ops = createWorktreeOperations({
      git,
      sessionService: fakeSessionService(),
      cleanupStorage,
      homeDir: home,
    });
    const record = await ops.spawn(CONTEXT, { branch: 'wt/storage' });

    await ops.close(CONTEXT, record.id, false);

    expect(git.removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: record.path }));
    expect(cleanupStorage).toHaveBeenCalledWith(repository, record.path);
  });

  it('keeps the registry record when generated storage cleanup fails', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/storage' });
    const git = fakeGit();
    const reopened = createWorktreeOperations({
      git,
      sessionService: fakeSessionService(),
      cleanupStorage: () => {
        throw new Error('permission denied');
      },
      homeDir: home,
    });

    await expect(reopened.close(CONTEXT, record.id, false)).rejects.toMatchObject({
      code: 'worktree_cleanup_failed',
      retryable: true,
    });
    expect(git.removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: record.path }));
    expect(await reopened.list(CONTEXT)).toEqual([expect.objectContaining({ id: record.id })]);
  });
  it('refuses a dirty worktree and names the files', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    fs.mkdirSync(record.path, { recursive: true });
    const dirty = fakeGit({ dirtyFiles: vi.fn().mockResolvedValue(['src/a.ts', 'src/b.ts']) });
    const reopened = createWorktreeOperations({
      git: dirty,
      sessionService: fakeSessionService(),
      homeDir: home,
    });

    await expect(reopened.close(CONTEXT, record.id, false)).rejects.toThrow(/src\/a\.ts, src\/b\.ts/u);
    expect(dirty.removeWorktree).not.toHaveBeenCalled();
  });

  it('removes a dirty worktree when forced', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    fs.mkdirSync(record.path, { recursive: true });
    const dirty = fakeGit({ dirtyFiles: vi.fn().mockResolvedValue(['src/a.ts']) });
    const reopened = createWorktreeOperations({
      git: dirty,
      sessionService: fakeSessionService(),
      homeDir: home,
    });

    await reopened.close(CONTEXT, record.id, true);
    expect(dirty.removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it('refuses an unknown id', async () => {
    const { ops } = operations(fakeGit());
    await expect(ops.close(CONTEXT, 'nope', false)).rejects.toThrow(/No worktree with id nope/u);
  });
});

describe('merge', () => {
  it('merges the worktree branch into the parent checkout', async () => {
    const git = fakeGit();
    const { ops } = operations(git);
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });

    await ops.merge(CONTEXT, record.id, 'ship it');

    expect(git.mergeBranch).toHaveBeenCalledWith({
      repositoryRoot: repository,
      branch: 'wt/one',
      message: 'ship it',
    });
  });

  // The merge commit lands in the parent, so the parent's own uncommitted edits
  // would be swept into it.
  it('refuses when the parent checkout is dirty', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const dirtyParent = fakeGit({ dirtyFiles: vi.fn().mockResolvedValue(['README.md']) });
    const reopened = createWorktreeOperations({
      git: dirtyParent,
      sessionService: fakeSessionService(),
      homeDir: home,
    });

    await expect(reopened.merge(CONTEXT, record.id)).rejects.toThrow(/parent checkout has 1 uncommitted/u);
    expect(dirtyParent.mergeBranch).not.toHaveBeenCalled();
  });
});

describe('list and status', () => {
  it('marks a record orphaned when its directory is gone, without deleting it', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });

    const listed = await ops.list(CONTEXT);

    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('orphaned');
    expect(listed[0]?.id).toBe(record.id);
  });

  it('reports a worktree and its dirty files', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    fs.mkdirSync(record.path, { recursive: true });
    const git = fakeGit({ dirtyFiles: vi.fn().mockResolvedValue(['src/a.ts']) });
    const reopened = createWorktreeOperations({
      git,
      sessionService: fakeSessionService(),
      homeDir: home,
    });

    await expect(reopened.status(CONTEXT, record.id)).resolves.toEqual({
      record: expect.objectContaining({ id: record.id }) as WorktreeRecord,
      dirtyFiles: ['src/a.ts'],
    });
  });
});

describe('prune', () => {
  it('changes nothing on a dry run', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    fs.mkdirSync(record.path, { recursive: true });
    const git = fakeGit({ listWorktreePaths: vi.fn().mockResolvedValue([record.path]) });
    const reopened = createWorktreeOperations({
      git,
      sessionService: fakeSessionService(),
      homeDir: home,
    });

    const plan = await reopened.prune(CONTEXT, true);

    expect(plan.remove.map((entry) => entry.id)).toEqual([record.id]);
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(await reopened.list(CONTEXT)).toHaveLength(1);
  });

  it('removes orphans git still lists and forgets the rest', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    fs.mkdirSync(record.path, { recursive: true });
    const git = fakeGit({ listWorktreePaths: vi.fn().mockResolvedValue([record.path]) });
    const reopened = createWorktreeOperations({
      git,
      sessionService: fakeSessionService(),
      homeDir: home,
    });

    await reopened.prune(CONTEXT, false);

    expect(git.removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: record.path, force: false }));
    expect(git.deleteBranch).toHaveBeenCalledWith({ repositoryRoot: repository, branch: 'wt/one' });
    expect(await reopened.list(CONTEXT)).toEqual([]);
  });

  it('removes generated storage for pruned worktrees', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/storage' });
    fs.mkdirSync(record.path, { recursive: true });
    const cleanupStorage = vi.fn();
    const reopened = createWorktreeOperations({
      git: fakeGit({ listWorktreePaths: vi.fn().mockResolvedValue([record.path]) }),
      sessionService: fakeSessionService(),
      cleanupStorage,
      homeDir: home,
    });

    await reopened.prune(CONTEXT, false);

    expect(cleanupStorage).toHaveBeenCalledWith(repository, record.path);
  });
  // The checkout goes with the prune; a branch holding commits does not.
  it('names a branch git refused to delete', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    fs.mkdirSync(record.path, { recursive: true });
    const git = fakeGit({
      listWorktreePaths: vi.fn().mockResolvedValue([record.path]),
      deleteBranch: vi.fn().mockResolvedValue(false),
    });
    const reopened = createWorktreeOperations({
      git,
      sessionService: fakeSessionService(),
      homeDir: home,
    });

    const plan = await reopened.prune(CONTEXT, false);

    expect(plan.keptBranches).toEqual(['wt/one']);
  });

  it('destroys nothing on a dry run, branches included', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    fs.mkdirSync(record.path, { recursive: true });
    const git = fakeGit({ listWorktreePaths: vi.fn().mockResolvedValue([record.path]) });
    const reopened = createWorktreeOperations({
      git,
      sessionService: fakeSessionService(),
      homeDir: home,
    });

    const plan = await reopened.prune(CONTEXT, true);

    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(plan.keptBranches).toEqual([]);
  });
  // An orphan is still the only pointer to a directory that may hold work.
  it('never deletes an orphan that still holds uncommitted work', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    fs.mkdirSync(record.path, { recursive: true });
    const git = fakeGit({
      listWorktreePaths: vi.fn().mockResolvedValue([record.path]),
      dirtyFiles: vi.fn().mockResolvedValue(['src/a.ts']),
    });
    const reopened = createWorktreeOperations({
      git,
      sessionService: fakeSessionService(),
      homeDir: home,
    });

    const plan = await reopened.prune(CONTEXT, false);

    expect(plan.keptDirty.map((entry) => entry.id)).toEqual([record.id]);
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(await reopened.list(CONTEXT)).toHaveLength(1);
  });

  it('reports a directory it did not create instead of touching it', async () => {
    const { ops } = operations(fakeGit());
    await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const stranger = path.join(home, '.pi', '.doom', 'git', 'worktrees', 'other--repo', 'by-hand--zzzzzzzz');
    const git = fakeGit({ listWorktreePaths: vi.fn().mockResolvedValue([stranger]) });
    const reopened = createWorktreeOperations({
      git,
      sessionService: fakeSessionService(),
      homeDir: home,
    });

    const plan = await reopened.prune(CONTEXT, false);

    expect(plan.untracked).toEqual([stranger]);
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });
});

describe('registry records', () => {
  it('carries the current record version so an older build ignores them', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    expect(record.version).toBe(WORKTREE_RECORD_VERSION);
  });
});

// Fail before Git side effects when the repository registry is already unwritable.
describe('spawn when the registry cannot be written', () => {
  it('refuses before starting a session or creating a checkout', async () => {
    const git = fakeGit();
    const stopSession = vi.fn().mockResolvedValue(undefined);
    const createSession = vi.fn().mockResolvedValue({ sessionId: 'session-9', cwd: '/worktree' });
    const ops = createWorktreeOperations({
      git,
      sessionService: fakeSessionService([], createSession, stopSession),
      homeDir: home,
    });
    const registry = path.join(home, '.pi', '.doom', 'git', 'registry');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, 'not a directory');

    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' })).rejects.toMatchObject({
      code: 'registry_write_failed',
      retryable: true,
    });

    expect(createSession).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
    expect(git.addWorktree).not.toHaveBeenCalled();
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });
});

/**
 * Two sessions in one checkout share this registry. Without an owner check
 * either could close the other's work in progress by id, so the guard is what
 * makes `parentSessionId` mean something rather than being decoration.
 */
describe('the owner guard', () => {
  const OTHER = { cwd: '/repo', sessionId: 'parent-2' };

  function withLiveParents(live: readonly string[], git: WorktreeGit) {
    return createWorktreeOperations({
      git,
      sessionService: fakeSessionService(live),
      homeDir: home,
    });
  }

  it('refuses to close a worktree another live session owns', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const git = fakeGit();
    const guarded = withLiveParents(['parent-1'], git);

    await expect(guarded.close(OTHER, record.id, false)).rejects.toMatchObject({ code: 'worktree_not_owned' });
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });

  it('refuses to merge a worktree another live session owns', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const git = fakeGit();
    const guarded = withLiveParents(['parent-1'], git);

    await expect(guarded.merge(OTHER, record.id, 'merge it')).rejects.toMatchObject({ code: 'worktree_not_owned' });
    expect(git.mergeBranch).not.toHaveBeenCalled();
  });

  it('lets the owning session close its own worktree', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const git = fakeGit();
    const guarded = withLiveParents(['parent-1'], git);

    await guarded.close(CONTEXT, record.id, false);
    expect(git.removeWorktree).toHaveBeenCalledOnce();
  });

  /**
   * The exception that keeps the fallback usable: an unowned worktree must
   * stay closable, or it would sit in the registry forever with nobody
   * entitled to remove it.
   */
  it('lets any session close a worktree whose parent is gone', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const git = fakeGit();
    const guarded = withLiveParents([], git);

    await guarded.close(OTHER, record.id, false);
    expect(git.removeWorktree).toHaveBeenCalledOnce();
  });
});

describe('direct worktree messages', () => {
  it('requires an exact session target for an inbox', () => {
    const bus = directEvents();
    expect(() => createWorktreeMessageInbox(bus, '')).toThrow('session identity');
  });

  it('routes messages and child reports through durable Session delivery', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const consume = vi.fn().mockReturnValue(true);
    const delivery = fakeDelivery({
      consume,
      inbox: vi.fn().mockReturnValue([
        {
          deliveryId: 'report-1',
          senderKey: 'session-9',
          recipientKey: 'parent-1',
          kind: 'git.worktree.report',
          prompt: 'Report from worktree',
          delivery: 'prompt',
          metadata: {
            worktreeId: record.id,
            fromRole: 'child',
            text: 'done',
            sentAt: '2026-01-01T00:00:00.000Z',
          },
          state: 'admitted',
          consumed: false,
        },
        {
          deliveryId: 'task-1',
          senderKey: 'parent-1',
          recipientKey: 'session-9',
          kind: 'git.worktree.delegation',
          prompt: 'recover task',
          delivery: 'prompt',
          metadata: { worktreeId: record.id, fromRole: 'parent', text: 'recover task' },
          state: 'recovery_required',
          consumed: false,
        },
      ]),
    });
    const durable = createWorktreeOperations({
      git: fakeGit(),
      sessionService: fakeSessionService(['parent-1', 'session-9']),
      sessionDelivery: () => delivery,
      homeDir: home,
    });

    await durable.send(CONTEXT, record.id, 'please finish');
    expect(delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientKey: 'session-9',
        kind: 'git.worktree.message',
        metadata: expect.objectContaining({ worktreeId: record.id, fromRole: 'parent', text: 'please finish' }),
      }),
    );
    await expect(durable.messages(CONTEXT, record.id)).resolves.toEqual([
      expect.objectContaining({ fromSessionId: 'session-9', from: 'child', text: 'done' }),
    ]);
    expect(consume).toHaveBeenCalledWith('report-1');
    await expect(durable.messages({ cwd: record.path, sessionId: 'session-9' }, record.id)).resolves.toEqual([
      expect.objectContaining({
        fromSessionId: 'parent-1',
        from: 'parent',
        text: '[Recovery required: prompt admission was not confirmed] recover task',
      }),
    ]);
    expect(consume).toHaveBeenCalledWith('task-1');
  });

  it('reports durable messages whose prompt admission needs recovery', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const delivery = fakeDelivery({ waitForAdmission: vi.fn().mockResolvedValue('recovery_required') });
    const durable = createWorktreeOperations({
      git: fakeGit(),
      sessionService: fakeSessionService(['parent-1', 'session-9']),
      sessionDelivery: () => delivery,
      homeDir: home,
    });

    await expect(durable.send(CONTEXT, record.id, 'please finish')).rejects.toMatchObject({
      code: 'message_delivery_failed',
      retryable: true,
    });
  });
  it('delivers messages only to the worktree peer inbox', async () => {
    const bus = directEvents();
    const parentInbox = createWorktreeMessageInbox(bus, CONTEXT.sessionId)!;
    const childInbox = createWorktreeMessageInbox(bus, 'session-9')!;
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const live = fakeSessionService(['parent-1', 'session-9']);
    const sender = createWorktreeOperations({
      git: fakeGit(),
      sessionService: live,
      messageInbox: parentInbox,
      homeDir: home,
    });
    const child = createWorktreeOperations({
      git: fakeGit(),
      sessionService: live,
      messageInbox: childInbox,
      homeDir: home,
    });

    await sender.send(CONTEXT, record.id, 'hello');
    expect(childInbox.receive(record.id)).toEqual([
      expect.objectContaining({ worktreeId: record.id, fromSessionId: 'parent-1', from: 'parent', text: 'hello' }),
    ]);
    await child.send({ cwd: record.path, sessionId: 'session-9' }, record.id, 'back');
    expect(parentInbox.receive(record.id)).toEqual([
      expect.objectContaining({ worktreeId: record.id, fromSessionId: 'session-9', from: 'child', text: 'back' }),
    ]);
  });

  it('bounds inboxes, rejects oversized messages, and closes idempotently', async () => {
    const bus = directEvents();
    const inbox = createWorktreeMessageInbox(bus, 'session-9')!;
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const live = fakeSessionService(['parent-1', 'session-9']);
    const sender = createWorktreeOperations({
      git: fakeGit(),
      sessionService: live,
      messageInbox: inbox,
      homeDir: home,
    });
    const message = (text: string) => ({
      version: 1 as const,
      worktreeId: 'wt1',
      fromSessionId: 'parent-1',
      from: 'parent' as const,
      text,
      sentAt: new Date().toISOString(),
    });
    const valid = message('valid');
    const invalid: unknown[] = [
      null,
      42,
      { ...valid, version: 0 },
      { ...valid, worktreeId: '' },
      { ...valid, fromSessionId: '' },
      { ...valid, from: 'other' },
      { ...valid, text: '' },
      { ...valid, sentAt: '' },
    ];
    for (const payload of invalid) bus.publish(GIT_WORKTREE_MESSAGE_EVENT, 'session-9', payload);
    expect(inbox.receive('wt1')).toEqual([]);

    for (let index = 0; index <= MAX_WORKTREE_INBOX_MESSAGES; index += 1) {
      bus.publish(GIT_WORKTREE_MESSAGE_EVENT, 'session-9', message(`message-${index}`));
    }
    const received = inbox.receive('wt1');
    expect(received).toHaveLength(MAX_WORKTREE_INBOX_MESSAGES);
    expect(received[0]?.text).toBe('message-1');

    const oversized = 'x'.repeat(MAX_WORKTREE_MESSAGE_BYTES + 1);
    await expect(sender.send(CONTEXT, record.id, oversized)).rejects.toMatchObject({ code: 'message_too_large' });
    await expect(sender.messages(CONTEXT, record.id)).resolves.toEqual([]);
    bus.publish(GIT_WORKTREE_MESSAGE_EVENT, 'session-9', message(oversized));
    expect(inbox.receive('wt1')).toEqual([]);
    inbox.close();
    inbox.close();
    bus.publish(GIT_WORKTREE_MESSAGE_EVENT, 'session-9', message('after-close'));
    expect(inbox.receive('wt1')).toEqual([]);
    expect(() => inbox.send('session-9', message('after-close'))).toThrow('closed');
  });
  it('rejects sends to dead peers and from unrelated sessions', async () => {
    const bus = directEvents();
    const inbox = createWorktreeMessageInbox(bus, CONTEXT.sessionId)!;
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    const deadPeer = createWorktreeOperations({
      git: fakeGit(),
      sessionService: fakeSessionService(['parent-1']),
      messageInbox: inbox,
      homeDir: home,
    });
    await expect(deadPeer.send(CONTEXT, record.id, 'late')).rejects.toMatchObject({
      code: 'worktree_peer_unavailable',
    });

    const unrelated = createWorktreeOperations({
      git: fakeGit(),
      sessionService: fakeSessionService(['parent-1', 'session-9']),
      messageInbox: inbox,
      homeDir: home,
    });
    await expect(unrelated.send({ cwd: repository, sessionId: 'parent-2' }, record.id, 'nope')).rejects.toMatchObject({
      code: 'worktree_not_owned',
    });
  });
});

describe('concurrent and reserved worktree creation', () => {
  it('keeps both records when independent sessions create worktrees concurrently', async () => {
    const create = vi.fn(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { sessionId: 'created', cwd: '/worktree' };
    });
    const first = operations(fakeGit(), create).ops;
    const second = operations(fakeGit(), create).ops;
    await Promise.all([
      first.spawn(CONTEXT, { branch: 'wt/one' }),
      second.spawn({ ...CONTEXT, sessionId: 'parent-2' }, { branch: 'wt/two' }),
    ]);
    expect((await first.list(CONTEXT)).map((record) => record.branch).sort()).toEqual(['wt/one', 'wt/two']);
  });

  it('rolls back when cancellation arrives after Git created the checkout', async () => {
    const controller = new AbortController();
    const git = fakeGit({
      addWorktree: vi.fn(async () => {
        controller.abort();
      }),
    });
    await expect(
      operations(git).ops.spawn(CONTEXT, { branch: 'wt/one' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'spawn_cancelled' });
    expect(git.removeWorktree).toHaveBeenCalledOnce();
    expect(git.deleteBranch).toHaveBeenCalledOnce();
  });

  it('retries binding after a lost completion without another worktree or runtime', async () => {
    let cwd: string | undefined;
    const git = fakeGit({
      addWorktree: vi.fn(async ({ path: checkout }) => {
        fs.mkdirSync(checkout, { recursive: true });
      }),
      listWorktreePaths: vi.fn(async () => (cwd === undefined ? [] : [cwd])),
      repositoryRoot: vi.fn(async (directory) => (directory === cwd ? directory : repository)),
      currentBranch: vi.fn(async () => 'wt/one'),
    });
    const create = vi.fn(async () => ({ sessionId: 'reserved-session', cwd: cwd! }));
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('store unavailable'))
      .mockResolvedValue({ sessionId: 'reserved-session' });
    let live = true;
    const ops = createWorktreeOperations({
      git,
      homeDir: home,
      sessionService: {
        ...fakeSessionService([], create),
        isLive: () => live,
        reservations: {
          read: () => ({ sessionId: 'reserved-session', cwd }),
          prepare: async (_id, _parent, directory) => {
            cwd = directory;
            return { sessionId: 'reserved-session', cwd };
          },
          complete,
        },
      },
    });
    const request = { branch: 'wt/one', reservationId: 'reserved-session' };
    await expect(ops.spawn(CONTEXT, request)).rejects.toThrow('store unavailable');
    const record = await ops.spawn(CONTEXT, request);
    expect(record.sessionId).toBe('reserved-session');
    expect(git.addWorktree).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    live = false;
    await ops.spawn(CONTEXT, request);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cwd: record.path,
        parentSessionId: CONTEXT.sessionId,
        reservationId: request.reservationId,
        sessionProvenance: 'worktree',
      }),
    );
    expect(git.addWorktree).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('retains a recorded checkout when the host refuses to recreate a dormant child', async () => {
    let cwd: string | undefined;
    const git = fakeGit({
      addWorktree: vi.fn(async ({ path: checkout }) => {
        fs.mkdirSync(checkout, { recursive: true });
      }),
      listWorktreePaths: vi.fn(async () => (cwd === undefined ? [] : [cwd])),
      repositoryRoot: vi.fn(async (directory) => (directory === cwd ? directory : repository)),
      currentBranch: vi.fn(async () => 'wt/one'),
    });
    let live = true;
    const create = vi.fn(async () => {
      if (!live) throw new Error('Resume the recorded session instead of recreating it.');
      return { sessionId: 'reserved-session', cwd: cwd! };
    });
    const complete = vi.fn().mockResolvedValue({ sessionId: 'reserved-session' });
    const ops = createWorktreeOperations({
      git,
      homeDir: home,
      sessionService: {
        ...fakeSessionService([], create),
        isLive: () => live,
        reservations: {
          read: () => ({ sessionId: 'reserved-session', cwd }),
          prepare: async (_id, _parent, directory) => {
            cwd = directory;
            return { sessionId: 'reserved-session', cwd };
          },
          complete,
        },
      },
    });
    const request = { branch: 'wt/one', reservationId: 'reserved-session' };
    const record = await ops.spawn(CONTEXT, request);
    live = false;
    await expect(ops.spawn(CONTEXT, request)).rejects.toThrow('Resume the recorded session');
    expect(fs.existsSync(record.path)).toBe(true);
    expect(git.addWorktree).toHaveBeenCalledOnce();
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('rejects a changed reserved checkout before recreating the missing child', async () => {
    let cwd: string | undefined;
    let branch = 'wt/one';
    const git = fakeGit({
      addWorktree: vi.fn(async ({ path: checkout }) => {
        fs.mkdirSync(checkout, { recursive: true });
      }),
      listWorktreePaths: vi.fn(async () => (cwd === undefined ? [] : [cwd])),
      repositoryRoot: vi.fn(async (directory) => (directory === cwd ? directory : repository)),
      currentBranch: vi.fn(async () => branch),
    });
    const create = vi.fn(async () => ({ sessionId: 'reserved-session', cwd: cwd! }));
    const ops = createWorktreeOperations({
      git,
      homeDir: home,
      sessionService: {
        ...fakeSessionService([], create),
        reservations: {
          read: () => ({ sessionId: 'reserved-session', cwd }),
          prepare: async (_id, _parent, directory) => {
            cwd = directory;
            return { sessionId: 'reserved-session', cwd };
          },
          complete: vi.fn().mockResolvedValue({ sessionId: 'reserved-session' }),
        },
      },
    });
    const request = { branch: 'wt/one', reservationId: 'reserved-session' };
    await ops.spawn(CONTEXT, request);
    branch = 'wt/other';
    await expect(ops.spawn(CONTEXT, request)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(create).toHaveBeenCalledOnce();
    expect(git.addWorktree).toHaveBeenCalledOnce();
  });
});
