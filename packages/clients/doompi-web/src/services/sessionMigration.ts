import type { MigratingSession } from '../types/remoteAccess.ts';
import { isInsideDirectory } from './pathScope.ts';

/**
 * Deciding which sessions can follow the cockpit into a container.
 *
 * A contained hub can only see the workspaces bind-mounted into it, so a
 * session working somewhere else cannot be recreated there: its `cwd` would not
 * exist. That is the containment doing its job rather than a bug, but it is
 * also the one thing a user can lose track of during a handover, so the split
 * is computed here, named, and reported rather than left implicit.
 *
 * Pure by design: no filesystem, so a test can name any path it likes.
 */

export interface SessionMigrationPlan {
  /** Sessions the container can recreate, because their cwd is under a mount. */
  migrate: MigratingSession[];
  /** Sessions the container cannot reach; they stay on the host. */
  stranded: MigratingSession[];
}

export function planSessionMigration(
  sessions: readonly MigratingSession[],
  workspaces: readonly string[],
): SessionMigrationPlan {
  const plan: SessionMigrationPlan = { migrate: [], stranded: [] };
  for (const session of sessions) {
    const reachable = workspaces.some((workspace) => isInsideDirectory(session.cwd, workspace));
    (reachable ? plan.migrate : plan.stranded).push(session);
  }
  return plan;
}

/**
 * What the host says about the sessions it is leaving behind.
 *
 * Named individually rather than counted, because the fix is to add one of
 * these directories to the workspace list and a count does not say which.
 */
export function describeStranded(stranded: readonly MigratingSession[]): string[] {
  if (stranded.length === 0) return [];
  return [
    `${String(stranded.length)} session(s) work outside the mounted workspaces and stay on the host:`,
    ...stranded.map((session) => `  ${session.name ?? session.id} in ${session.cwd}`),
    'Add those directories to the workspace list to bring them into the container.',
  ];
}
