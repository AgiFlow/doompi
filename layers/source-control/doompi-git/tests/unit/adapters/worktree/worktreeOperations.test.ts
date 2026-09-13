import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomDirectEventBus } from '@agimon-ai/doompi-core/hub-channel';
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

function operations(
  git: WorktreeGit,
  createSession = vi.fn().mockResolvedValue({ sessionId: 'session-9', cwd: '/worktree' }),
) {
  const sessionService = fakeSessionService([], createSession);
  return {
    ops: createWorktreeOperations({ git, sessionService, homeDir: home }),
    createSession,
    sessionService,
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

// A session nothing has a record for is unreachable: it runs, and no id names
// it. The session goes back with the worktree rather than being left behind.
describe('spawn when the registry cannot be written', () => {
  it('stops the session it started and rolls the worktree back', async () => {
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

    expect(stopSession).toHaveBeenCalledWith('session-9');
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
