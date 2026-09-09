import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubUnavailableError } from '../../../../src/adapters/hub/hubClient.ts';
import { createWorktreeOperations } from '../../../../src/adapters/worktree/worktreeOperations.ts';
import { WORKTREE_RECORD_VERSION } from '../../../../src/types/worktreeRegistry.ts';
import type { WorktreeGit, WorktreeRecord } from '../../../../src/types/worktreeRegistry.ts';

let home: string;
let repository: string;

const CONTEXT = { cwd: '/repo', sessionId: 'parent-1' };

function fakeGit(overrides: Partial<WorktreeGit> = {}): WorktreeGit {
  return {
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    pruneWorktrees: vi.fn().mockResolvedValue(undefined),
    listWorktreePaths: vi.fn().mockResolvedValue([]),
    dirtyFiles: vi.fn().mockResolvedValue([]),
    repositoryRoot: vi.fn().mockResolvedValue(repository),
    currentBranch: vi.fn().mockResolvedValue('main'),
    mergeBranch: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function operations(git: WorktreeGit, createSession = vi.fn().mockResolvedValue('session-9')) {
  return {
    ops: createWorktreeOperations({ git, createSession, homeDir: home, registryDir: path.join(home, 'run') }),
    createSession,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-ops-'));
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-repo-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repository, { recursive: true, force: true });
});

describe('spawn', () => {
  it('creates the worktree, starts a session, and records both', async () => {
    const git = fakeGit();
    const { ops, createSession } = operations(git);

    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });

    expect(git.addWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryRoot: repository, branch: 'wt/one', baseRef: 'main' }),
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

  it('uses an explicit baseRef over the current branch', async () => {
    const git = fakeGit();
    const { ops } = operations(git);
    await ops.spawn(CONTEXT, { branch: 'wt/one', baseRef: 'v1.0' });
    expect(git.addWorktree).toHaveBeenCalledWith(expect.objectContaining({ baseRef: 'v1.0' }));
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

  it('rolls the worktree back when the caller gives up before the session starts', async () => {
    const git = fakeGit();
    const createSession = vi.fn();
    const { ops } = operations(git, createSession);

    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' }, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'spawn_cancelled',
    });

    expect(createSession).not.toHaveBeenCalled();
    expect(git.removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(git.deleteBranch).toHaveBeenCalledWith({ repositoryRoot: repository, branch: 'wt/one' });
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
      return Promise.resolve('session-9');
    });
    const ops = createWorktreeOperations({
      git: fakeGit(),
      createSession,
      mirror,
      homeDir: home,
      registryDir: path.join(home, 'run'),
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

  it('refuses a dirty worktree and names the files', async () => {
    const { ops } = operations(fakeGit());
    const record = await ops.spawn(CONTEXT, { branch: 'wt/one' });
    fs.mkdirSync(record.path, { recursive: true });
    const dirty = fakeGit({ dirtyFiles: vi.fn().mockResolvedValue(['src/a.ts', 'src/b.ts']) });
    const reopened = createWorktreeOperations({
      git: dirty,
      createSession: vi.fn(),
      homeDir: home,
      registryDir: path.join(home, 'run'),
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
      createSession: vi.fn(),
      homeDir: home,
      registryDir: path.join(home, 'run'),
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
      createSession: vi.fn(),
      homeDir: home,
      registryDir: path.join(home, 'run'),
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
      createSession: vi.fn(),
      homeDir: home,
      registryDir: path.join(home, 'run'),
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
      createSession: vi.fn(),
      homeDir: home,
      registryDir: path.join(home, 'run'),
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
      createSession: vi.fn(),
      homeDir: home,
      registryDir: path.join(home, 'run'),
    });

    await reopened.prune(CONTEXT, false);

    expect(git.removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: record.path, force: false }));
    expect(git.deleteBranch).toHaveBeenCalledWith({ repositoryRoot: repository, branch: 'wt/one' });
    expect(await reopened.list(CONTEXT)).toEqual([]);
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
      createSession: vi.fn(),
      homeDir: home,
      registryDir: path.join(home, 'run'),
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
      createSession: vi.fn(),
      homeDir: home,
      registryDir: path.join(home, 'run'),
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
      createSession: vi.fn(),
      homeDir: home,
      registryDir: path.join(home, 'run'),
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
      createSession: vi.fn(),
      homeDir: home,
      registryDir: path.join(home, 'run'),
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

// A session nothing has a record for is unreachable: it runs, and no id names
// it. The session goes back with the worktree rather than being left behind.
describe('spawn when the registry cannot be written', () => {
  it('stops the session it started and rolls the worktree back', async () => {
    const git = fakeGit();
    const stopSession = vi.fn().mockResolvedValue(undefined);
    const createSession = vi.fn().mockResolvedValue('session-9');
    const ops = createWorktreeOperations({
      git,
      createSession,
      stopSession,
      homeDir: home,
      registryDir: path.join(home, 'run'),
    });
    const registry = path.join(home, '.pi', '.doom', 'git', 'registry');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, 'not a directory');

    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' })).rejects.toMatchObject({
      code: 'registry_write_failed',
      retryable: true,
    });

    expect(stopSession).toHaveBeenCalledWith(path.join(home, 'run'), 'session-9');
    expect(git.removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(git.deleteBranch).toHaveBeenCalledWith({ repositoryRoot: repository, branch: 'wt/one' });
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
      createSession: vi.fn().mockResolvedValue('session-9'),
      homeDir: home,
      registryDir: path.join(home, 'run'),
      isSessionLive: (_dir, sessionId) => live.includes(sessionId),
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
