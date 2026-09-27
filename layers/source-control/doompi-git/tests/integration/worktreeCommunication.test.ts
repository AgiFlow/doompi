import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomDirectEventBus, DoomHubSessionService } from '@agimon-ai/doompi-core/hubChannel';
import { afterEach, expect, it, vi } from 'vitest';

import { createWorktreeGit } from '../../src/services/gitCli';
import { createWorktreeMessageInbox } from '../../src/services/worktreeEvents';
import { createWorktreeOperations } from '../../src/services/worktreeOperations';

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it('routes nested A to B to C messages by the immediate worktree id, not an ancestor id or checkout root', async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-communication-')));
  const home = path.join(root, 'home');
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
  const gitCommand = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: path.join(root!, 'empty-gitconfig'),
        GIT_CONFIG_SYSTEM: path.join(root!, 'empty-gitconfig'),
      },
    });
  fs.writeFileSync(path.join(root, 'empty-gitconfig'), '');
  gitCommand(repository, 'init', '--initial-branch=main');
  gitCommand(repository, 'config', 'user.email', 'test@example.com');
  gitCommand(repository, 'config', 'user.name', 'Test');
  gitCommand(repository, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repository, 'README.md'), 'initial\n');
  gitCommand(repository, 'add', 'README.md');
  gitCommand(repository, 'commit', '-m', 'initial');

  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const key = (event: string, sessionId: string): string => `${event}:${sessionId}`;
  const bus: DoomDirectEventBus = {
    publish(event, sessionId, payload) {
      for (const listener of listeners.get(key(event, sessionId)) ?? []) listener(payload);
    },
    subscribe(event, sessionId, listener) {
      const address = key(event, sessionId);
      const current = listeners.get(address) ?? new Set<(payload: unknown) => void>();
      current.add(listener);
      listeners.set(address, current);
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(address);
      };
    },
    close: () => listeners.clear(),
  };
  const aInbox = createWorktreeMessageInbox(bus, 'A');
  const bInbox = createWorktreeMessageInbox(bus, 'B');
  const cInbox = createWorktreeMessageInbox(bus, 'C');
  try {
    const live = new Set(['A', 'B', 'C']);
    const sessionService = {
      create: vi
        .fn()
        .mockImplementation(async ({ cwd, parentSessionId }: { cwd: string; parentSessionId: string }) => ({
          sessionId: parentSessionId === 'A' ? 'B' : 'C',
          cwd,
        })),
      isLive: (sessionId: string) => live.has(sessionId),
    } as unknown as DoomHubSessionService;
    const deps = { git: createWorktreeGit(), sessionService, homeDir: home, mirror: vi.fn() };
    const a = createWorktreeOperations({ ...deps, messageInbox: aInbox });
    const b = createWorktreeOperations({ ...deps, messageInbox: bInbox });
    const c = createWorktreeOperations({ ...deps, messageInbox: cInbox });
    const aContext = { cwd: repository, sessionId: 'A' };
    const ab = await a.spawn(aContext, { branch: 'wt-b', baseRef: 'main' });
    const bContext = { cwd: ab.path, sessionId: 'B' };
    const bc = await b.spawn(bContext, { branch: 'wt-c', baseRef: 'main' });
    const cContext = { cwd: bc.path, sessionId: 'C' };

    expect(ab.sessionId).toBe('B');
    expect(ab.parentSessionId).toBe('A');
    expect(bc.sessionId).toBe('C');
    expect(bc.parentSessionId).toBe('B');
    expect(ab.id).not.toBe(bc.id);
    expect(new Set([repository, ab.path, bc.path]).size).toBe(3);
    expect(ab.repositoryRoot).toBe(repository);
    expect(bc.repositoryRoot).toBe(ab.path);
    expect(await c.list(cContext)).toEqual(expect.arrayContaining([ab, bc]));

    await c.send(cContext, bc.id, 'C to B');
    expect(await b.messages(bContext, bc.id)).toEqual([
      expect.objectContaining({ worktreeId: bc.id, fromSessionId: 'C', from: 'child', text: 'C to B' }),
    ]);
    expect(await a.messages(aContext, ab.id)).toEqual([]);
    await b.send(bContext, bc.id, 'B to C');
    expect(await c.messages(cContext, bc.id)).toEqual([
      expect.objectContaining({ worktreeId: bc.id, fromSessionId: 'B', from: 'parent', text: 'B to C' }),
    ]);
    await b.send(bContext, ab.id, 'B to A');
    expect(await a.messages(aContext, ab.id)).toEqual([
      expect.objectContaining({ worktreeId: ab.id, fromSessionId: 'B', from: 'child', text: 'B to A' }),
    ]);
    await a.send(aContext, ab.id, 'A to B');
    expect(await b.messages(bContext, ab.id)).toEqual([
      expect.objectContaining({ worktreeId: ab.id, fromSessionId: 'A', from: 'parent', text: 'A to B' }),
    ]);

    await expect(c.send(cContext, ab.id, 'skip B')).rejects.toMatchObject({ code: 'worktree_not_owned' });
    await expect(a.send(aContext, bc.id, 'skip B')).rejects.toMatchObject({ code: 'worktree_not_owned' });
    await expect(c.messages(cContext, ab.id)).rejects.toMatchObject({ code: 'worktree_not_owned' });
    expect(await b.messages(bContext, bc.id)).toEqual([]);
    expect(await a.messages(aContext, ab.id)).toEqual([]);
  } finally {
    aInbox.close();
    bInbox.close();
    cInbox.close();
    bus.close();
  }
});
