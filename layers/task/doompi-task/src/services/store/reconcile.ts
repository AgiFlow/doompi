import { isProcessAlive } from './processLiveness.ts';
import { isDelegationActive, type Task, type TaskDocument } from './types.ts';

export const ERR_ORPHANED_BY_RESTART = 'Delegation orphaned by harness restart';
export const ERR_ORPHANED_BY_SESSION = 'Delegation orphaned by session restart';

export interface ReconcileResult {
  document: TaskDocument;
  orphaned: Task[];
}

/** The delegations this process can still settle, used to spot its own leftovers. */
export interface ReconcileSelf {
  pid: number;
  liveRequestIds: ReadonlySet<string>;
}

/**
 * Recover tasks that no longer have anyone able to finish them.
 *
 * A subagent run dies with the harness that spawned it, but the store file
 * outlives both, so a crash leaves tasks stuck in `in_progress` forever. Two
 * kinds of delegation qualify as dead:
 *
 * - the owning pid is gone, so nothing is left to report a result;
 * - the owning pid is *this* process, yet the request is absent from the live
 *   set. Settling requires an in-memory record, so an in-process session
 *   restart (which clears that map without writing to the store) leaves rows
 *   nothing can ever resolve. Checking pid liveness alone misses these, because
 *   the pid is our own and very much alive.
 *
 * Delegations owned by a different, still-running pid belong to a parallel
 * session and are left untouched.
 */
export function reconcileOrphanedDelegations(
  document: TaskDocument,
  now: string = new Date().toISOString(),
  isAlive: (pid: number) => boolean = isProcessAlive,
  self?: ReconcileSelf,
): ReconcileResult {
  const orphaned: Task[] = [];

  const tasks = document.tasks.map((task) => {
    if (!isDelegationActive(task)) return task;
    const pid = task.delegation?.pid;
    if (pid === undefined) return task;

    const ownedByThisSession = self !== undefined && pid === self.pid;
    const abandonedHere = ownedByThisSession && !self.liveRequestIds.has(task.delegation!.requestId);
    if (!abandonedHere && isAlive(pid)) return task;

    const recovered: Task = {
      ...task,
      status: 'pending',
      updatedAt: now,
      delegation: {
        ...task.delegation!,
        state: 'failed',
        endedAt: now,
        result: {
          status: 'failed',
          error: abandonedHere ? ERR_ORPHANED_BY_SESSION : ERR_ORPHANED_BY_RESTART,
        },
      },
    };
    orphaned.push(recovered);
    return recovered;
  });

  if (orphaned.length === 0) return { document, orphaned };
  return { document: { ...document, tasks }, orphaned };
}
