import type { SyncRegistration } from '@agimon-ai/doompi-core/syncRegistration';

export async function resolveSessionArtifact(input: {
  readonly worktree: boolean;
  readonly pinned?: SyncRegistration;
  readonly parent?: SyncRegistration;
  readonly prepareCurrent: () => Promise<SyncRegistration>;
}): Promise<SyncRegistration> {
  if (!input.worktree) return input.prepareCurrent();
  const artifact = input.pinned ?? input.parent;
  if (artifact === undefined) throw new Error('Worktree session requires its parent compiled artifact.');
  return artifact;
}
