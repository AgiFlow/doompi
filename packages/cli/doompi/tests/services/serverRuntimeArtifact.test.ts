import type { SyncRegistration } from '@agimon-ai/doompi-core/syncRegistration';
import { describe, expect, it, vi } from 'vitest';

import { resolveSessionArtifact, resolveWorktreeRestart } from '../../src/builders/server/sessionArtifact';

function registration(generation: string): SyncRegistration {
  return { generation } as SyncRegistration;
}

describe('resolveSessionArtifact', () => {
  it('inherits the live parent generation without preparing the worktree', async () => {
    const parent = registration('parent');
    const prepareCurrent = vi.fn().mockResolvedValue(registration('child'));

    await expect(resolveSessionArtifact({ member: true, parent, prepareCurrent })).resolves.toBe(parent);
    expect(prepareCurrent).not.toHaveBeenCalled();
  });

  it('keeps a persisted generation after its parent moves on', async () => {
    const pinned = registration('pinned');
    const prepareCurrent = vi.fn().mockResolvedValue(registration('child'));

    await expect(
      resolveSessionArtifact({
        member: true,
        pinned,
        parent: registration('new-parent'),
        prepareCurrent,
      }),
    ).resolves.toBe(pinned);
    expect(prepareCurrent).not.toHaveBeenCalled();
  });

  it('prepares the current checkout for a normal session', async () => {
    const current = registration('current');
    const prepareCurrent = vi.fn().mockResolvedValue(current);

    await expect(resolveSessionArtifact({ member: false, prepareCurrent })).resolves.toBe(current);
    expect(prepareCurrent).toHaveBeenCalledOnce();
  });

  it('runs the workspace generation for a checkout that joined without a parent', async () => {
    const current = registration('workspace');
    const prepareCurrent = vi.fn().mockResolvedValue(registration('checkout'));

    await expect(resolveSessionArtifact({ member: true, workspace: () => current, prepareCurrent })).resolves.toBe(
      current,
    );
    expect(prepareCurrent).not.toHaveBeenCalled();
  });

  it('fails closed when a member checkout has no workspace generation', async () => {
    const prepareCurrent = vi.fn().mockResolvedValue(registration('child'));

    await expect(resolveSessionArtifact({ member: true, workspace: () => undefined, prepareCurrent })).rejects.toThrow(
      'A member checkout requires its workspace compiled artifact.',
    );
    expect(prepareCurrent).not.toHaveBeenCalled();
  });
});

describe('resolveWorktreeRestart', () => {
  const workspace = { id: 'original', root: '/repo' };
  const artifact = { root: '/repo', generation: 'parent' } as SyncRegistration;
  const session = { id: 'child', cwd: '/checkout', workspaceId: 'original', parentSessionId: 'closed-parent' };
  const record = {
    sessionId: 'child',
    workspaceId: 'original',
    cwd: '/checkout',
    groupingRoot: '/repo',
    parentSessionId: 'closed-parent',
    name: 'child',
    createdAt: '2025-01-01T00:00:00.000Z',
    artifact,
  };

  it('pins the original workspace and artifact after the parent closes', () => {
    expect(resolveWorktreeRestart({ session, record, workspaces: [workspace] })).toEqual({
      workspaceId: 'original',
      artifact,
    });
    expect(resolveWorktreeRestart({ session, artifact, workspaces: [workspace] })).toEqual({
      workspaceId: 'original',
      artifact,
    });
  });

  it('rejects missing workspace or changed ownership before closing the child', () => {
    expect(() => resolveWorktreeRestart({ session, record, workspaces: [] })).toThrow('still running');
    expect(() =>
      resolveWorktreeRestart({ session, record: { ...record, workspaceId: 'checkout' }, workspaces: [workspace] }),
    ).toThrow('still running');
    expect(() =>
      resolveWorktreeRestart({ session, record: { ...record, groupingRoot: '/checkout' }, workspaces: [workspace] }),
    ).toThrow('still running');
  });

  it('rejects a missing artifact or one from another workspace', () => {
    expect(() =>
      resolveWorktreeRestart({ session, record: { ...record, artifact: undefined }, workspaces: [workspace] }),
    ).toThrow('still running');
    expect(() =>
      resolveWorktreeRestart({
        session,
        record,
        artifact: { ...artifact, root: '/checkout' },
        workspaces: [workspace],
      }),
    ).toThrow('still running');
  });
});
