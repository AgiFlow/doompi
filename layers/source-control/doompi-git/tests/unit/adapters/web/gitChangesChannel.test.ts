import type { DoomDirectEventBus, DoomHubChannelHost, DoomHubSessionScope } from '@agimon-ai/doompi-core/hubChannel';
import { describe, expect, it, vi } from 'vitest';

import {
  createGitChangesChannel,
  parseChangesCommand,
} from '../../../../src/extensions/(backend)/channel/_lib/git-changes.server';
import type { BranchDiff, BranchReview } from '../../../../src/services/branchDiff/type';
import { DoomGitExpectedError } from '../../../../src/services/errors';
import type { GitAuthStore } from '../../../../src/services/gitAuth/type';
import type { GitSync } from '../../../../src/services/gitSync/type';
import { GIT_SESSION_CHANGED_EVENT } from '../../../../src/services/worktreeEvents';
import type { GitChangesPayload } from '../../../../src/types/gitReview';

const CONNECTION = { connectionId: 'c1' };

const SCOPE: DoomHubSessionScope = {
  sessionId: 's1',
  cwd: '/tmp/doompi-git-not-a-repo',
  sessionContext: {
    sessionId: 's1',
    workspaceId: 'w1',
    workspaceRoot: '/workspace',
    checkoutRoot: '/tmp/doompi-git-not-a-repo',
    cwd: '/tmp/doompi-git-not-a-repo',
  },
};

function review(added: number): BranchReview {
  return {
    root: SCOPE.cwd,
    base: { ref: 'origin/main', from: 'abc' },
    changes: { branch: 'feat/x', base: 'origin/main', added, removed: 1, files: 1 },
    summary: { repository: true, files: [] },
  };
}

/** A direct event bus that delivers synchronously, like the hub's. */
function bus(): DoomDirectEventBus {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  return {
    publish: (type: string, sessionId: string, payload: unknown) =>
      listeners.get(`${type}:${sessionId}`)?.forEach((listener) => listener(payload)),
    subscribe: (type: string, sessionId: string, listener: (payload: unknown) => void) => {
      const key = `${type}:${sessionId}`;
      listeners.set(key, [...(listeners.get(key) ?? []), listener]);
      return () =>
        listeners.set(
          key,
          (listeners.get(key) ?? []).filter((entry) => entry !== listener),
        );
    },
    close: vi.fn(),
  } as unknown as DoomDirectEventBus;
}

function harness(overrides: { diff?: BranchDiff; sync?: Partial<GitSync> } = {}) {
  const published: GitChangesPayload[] = [];
  const directEvents = bus();
  const host = {
    sessions: () => [SCOPE],
    directEvents,
    publish: (_sessionId: string, payload: unknown) => published.push(payload as GitChangesPayload),
    onNotice: vi.fn(),
  } as unknown as DoomHubChannelHost;
  let added = 3;
  const diff: BranchDiff = overrides.diff ?? { review: vi.fn(async () => review(added)), fileDiff: vi.fn() };
  const auth: GitAuthStore = { read: vi.fn(() => ({ method: 'none' as const })), view: vi.fn(), save: vi.fn() };
  const done = async () => ({ outcome: 'done' as const });
  const sync: GitSync = {
    pull: vi.fn(done),
    push: vi.fn(done),
    rebase: vi.fn(done),
    abortRebase: vi.fn(done),
    ...overrides.sync,
  };
  const channel = createGitChangesChannel({ homeDir: '/tmp/doompi-git-no-home', diff, sync, auth });
  const source = channel.start(host);
  return {
    published,
    directEvents,
    diff,
    sync,
    auth,
    source,
    channel,
    setAdded: (value: number) => {
      added = value;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('git changes channel', () => {
  it('publishes the counts when a session joins, and again when the session reports a change', async () => {
    const test = harness();
    test.source.sessionAdded?.(SCOPE);
    await settle();
    expect(test.published.at(-1)?.changes).toMatchObject({ added: 3, base: 'origin/main' });

    test.setAdded(9);
    test.directEvents.publish(GIT_SESSION_CHANGED_EVENT, 's1', { version: 1 });
    await settle();
    expect(test.published.at(-1)?.changes?.added).toBe(9);
  });

  it('coalesces a burst of changes into one rerun', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reviewSpy = vi.fn(async () => {
      await gate;
      return review(1);
    });
    const test = harness({ diff: { review: reviewSpy, fileDiff: vi.fn() } });
    test.source.sessionAdded?.(SCOPE);
    for (let index = 0; index < 5; index += 1)
      test.directEvents.publish(GIT_SESSION_CHANGED_EVENT, 's1', { version: 1 });
    release();
    await settle();
    await settle();
    expect(reviewSpy).toHaveBeenCalledTimes(2);
  });

  it('runs a sync command with the workspace auth, showing pending until it ends', async () => {
    const test = harness();
    test.source.sessionAdded?.(SCOPE);
    await settle();
    test.channel.receive?.(SCOPE, { action: 'pull' }, CONNECTION);
    expect(test.published.at(-1)?.pending).toBe('pulling…');
    await settle();
    expect(test.auth.read).toHaveBeenCalledWith('/workspace');
    expect(test.sync.pull).toHaveBeenCalledTimes(1);
    expect(test.published.at(-1)?.pending).toBeUndefined();
  });

  it('asks for a confirmed lease force when a plain push is rejected, and runs one command at a time', async () => {
    const rejected = vi.fn(async () => {
      throw new DoomGitExpectedError(
        'push_needs_force',
        'The remote branch has commits yours replaced.',
        false,
        'Confirm a force push.',
      );
    });
    const test = harness({ sync: { push: rejected } });
    test.source.sessionAdded?.(SCOPE);
    await settle();
    test.channel.receive?.(SCOPE, { action: 'push' }, CONNECTION);
    test.channel.receive?.(SCOPE, { action: 'push' }, CONNECTION);
    await settle();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(test.published.at(-1)).toMatchObject({ errorTarget: { action: 'push', forceRequired: true } });
    expect(test.published.at(-1)?.error).toBe('The remote branch has commits yours replaced. Confirm a force push.');
  });

  it('accepts only the four sync commands', () => {
    expect(parseChangesCommand({ action: 'push', force: true })).toEqual({ action: 'push', force: true });
    expect(parseChangesCommand({ action: 'push', force: 'yes' })).toEqual({ action: 'push' });
    expect(parseChangesCommand({ action: 'create', branch: 'x' })).toBeUndefined();
    expect(parseChangesCommand(null)).toBeUndefined();
  });
});
