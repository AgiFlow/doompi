import type { SyncRegistration } from '@agimon-ai/doompi-core/syncRegistration';
import { describe, expect, it, vi } from 'vitest';

import { resolveSessionArtifact } from '../../src/builders/server/runtime';

function registration(generation: string): SyncRegistration {
  return { generation } as SyncRegistration;
}

describe('resolveSessionArtifact', () => {
  it('inherits the live parent generation without preparing the worktree', async () => {
    const parent = registration('parent');
    const prepareCurrent = vi.fn().mockResolvedValue(registration('child'));

    await expect(resolveSessionArtifact({ worktree: true, parent, prepareCurrent })).resolves.toBe(parent);
    expect(prepareCurrent).not.toHaveBeenCalled();
  });

  it('keeps a persisted generation after its parent moves on', async () => {
    const pinned = registration('pinned');
    const prepareCurrent = vi.fn().mockResolvedValue(registration('child'));

    await expect(
      resolveSessionArtifact({
        worktree: true,
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

    await expect(resolveSessionArtifact({ worktree: false, prepareCurrent })).resolves.toBe(current);
    expect(prepareCurrent).toHaveBeenCalledOnce();
  });

  it('fails closed when a worktree has no inherited generation', async () => {
    const prepareCurrent = vi.fn().mockResolvedValue(registration('child'));

    await expect(resolveSessionArtifact({ worktree: true, prepareCurrent })).rejects.toThrow(
      'Worktree session requires its parent compiled artifact.',
    );
    expect(prepareCurrent).not.toHaveBeenCalled();
  });
});
