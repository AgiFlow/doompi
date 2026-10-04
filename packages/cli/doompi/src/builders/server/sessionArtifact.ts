import type { OpenSessionRecord } from '@agimon-ai/doompi-core/history';
import type { SyncRegistration } from '@agimon-ai/doompi-core/syncRegistration';

/** Pin a worktree restart to its recorded workspace before stopping the running child. */
export function resolveWorktreeRestart(input: {
  readonly session: { id: string; cwd: string; workspaceId?: string; parentSessionId?: string };
  readonly record?: OpenSessionRecord;
  readonly artifact?: SyncRegistration;
  readonly workspaces: readonly { id: string; root: string; available?: boolean }[];
}): { workspaceId: string; artifact: SyncRegistration } {
  const { session, record } = input;
  const workspace = input.workspaces.find(
    (candidate) => candidate.id === session.workspaceId && candidate.available !== false,
  );
  if (
    workspace === undefined ||
    (record !== undefined &&
      (record.workspaceId !== workspace.id ||
        record.cwd !== session.cwd ||
        (record.groupingRoot !== undefined && record.groupingRoot !== workspace.root) ||
        (record.parentSessionId !== undefined && record.parentSessionId !== session.parentSessionId)))
  )
    throw new Error('Worktree workspace is unavailable; the session is still running.');
  const artifact = input.artifact ?? record?.artifact;
  if (
    artifact === undefined ||
    artifact.root !== workspace.root ||
    (record?.artifact && record.artifact.root !== workspace.root)
  )
    throw new Error('Worktree generation is unavailable; the session is still running.');
  return { workspaceId: workspace.id, artifact };
}

/**
 * A member checkout (a checkout that is not its workspace root, such as a worktree) runs a
 * compiled workspace generation: the one it recorded, its parent's, or the workspace's current.
 */
export async function resolveSessionArtifact(input: {
  readonly member: boolean;
  readonly pinned?: SyncRegistration;
  readonly parent?: SyncRegistration;
  readonly workspace?: () => SyncRegistration | undefined;
  readonly synchronize?: () => Promise<void>;
  readonly prepareCurrent: () => Promise<SyncRegistration>;
}): Promise<SyncRegistration> {
  if (!input.member) {
    await input.synchronize?.();
    return input.prepareCurrent();
  }
  const artifact = input.pinned ?? input.parent ?? input.workspace?.();
  if (artifact === undefined) throw new Error('A member checkout requires its workspace compiled artifact.');
  return artifact;
}
