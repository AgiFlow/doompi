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
    ...overrides,
  };
}

function operations(git: WorktreeGit, createSession = vi.fn().mockResolvedValue('session-9')) {
  return {
    ops: createWorktreeOperations({ git, createSession, homeDir: home, registryDir: path.join(home, 'run') }),
    createSession,
  };
}

/**
 * A worktree whose install failed is worse than no worktree: the session that
 * opens in it silently falls back to the global bundle and loses the
 * repository's own packages. So the directory has to go back.
 */
async function spawnWithFailedInstall(git: WorktreeGit) {
  const install = vi.fn().mockResolvedValue({ kind: 'failed', command: 'pnpm', code: 1, stderrBytes: 42 });
  const createSession = vi.fn();
  const ops = createWorktreeOperations({
    git,
    createSession,
    install,
    homeDir: home,
    registryDir: path.join(home, 'run'),
  });
  return { ops, install, createSession };
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
    expect(await ops.list(CONTEXT)).toEqual([]);
  });

  it('reports a missing cockpit as retryable rather than as a git failure', async () => {
    const createSession = vi.fn().mockRejectedValue(new HubUnavailableError('No cockpit is running.'));
    const { ops } = operations(fakeGit(), createSession);
    await expect(ops.spawn(CONTEXT, { branch: 'wt/one' })).rejects.toThrow(/hub_unavailable/u);
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
    expect(await reopened.list(CONTEXT)).toEqual([]);
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

describe('spawn when the install fails', () => {
  it('removes the worktree and never starts a session', async () => {
    const git = {
      isRepository: vi.fn().mockResolvedValue(true),
      repositoryRoot: vi.fn().mockResolvedValue(repository),
      currentBranch: vi.fn().mockResolvedValue('main'),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorktreeGit;
    const { ops, install, createSession } = await spawnWithFailedInstall(git);

    await expect(ops.spawn({ cwd: repository, sessionId: 'parent' }, { branch: 'wt/x' })).rejects.toMatchObject({
      code: 'install_failed',
      retryable: true,
    });

    expect(install).toHaveBeenCalledOnce();
    expect(createSession).not.toHaveBeenCalled();
    expect(git.removeWorktree).toHaveBeenCalledOnce();
  });
});
