/**
 * Naming and reconciliation rules for worktrees, as pure functions.
 *
 * Everything here is a function of its arguments so the interesting decisions,
 * which are the ones about destroying work, can be tested without a repository
 * or a filesystem.
 */

import type { WorktreeRecord } from '../types/worktreeRegistry.ts';

const MAX_SLUG_LENGTH = 64;

/**
 * A branch name reduced to one safe path segment.
 *
 * Slashes are the point: `wt/fix-auth` is a perfectly good branch and a
 * terrible directory name, because the nested directory it implies is not the
 * one the worktree lives in.
 */
export function branchSlug(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/gu, '');
  return slug === '' ? 'worktree' : slug;
}

/**
 * The directory for one worktree.
 *
 * The short id disambiguates two branches whose slugs collide, such as
 * `feature/x` and `feature_x`, which would otherwise want the same directory.
 */
export function worktreeDirectory(input: {
  worktreesRoot: string;
  repositoryLabel: string;
  repositoryId: string;
  branch: string;
  shortId: string;
}): string {
  const repository = `${input.repositoryLabel}--${input.repositoryId}`;
  return `${input.worktreesRoot}/${repository}/${branchSlug(input.branch)}--${input.shortId}`;
}

/** Why a worktree cannot be created, or undefined when it can. */
export function refuseSpawn(input: { branch: string; existing: readonly WorktreeRecord[] }): string | undefined {
  if (input.branch.trim() === '') return 'A branch name is required.';
  // Git refuses a second worktree on one branch, but its message names a path
  // the caller never chose, so this says it in the caller's own terms first.
  const live = input.existing.find((record) => record.branch === input.branch && record.status !== 'orphaned');
  if (live) return `Branch ${input.branch} already has a worktree (${live.id}).`;
  return undefined;
}

/** Why a worktree cannot be closed, or undefined when it can. */
export function refuseClose(input: {
  record: WorktreeRecord | undefined;
  dirtyFiles: readonly string[];
  force: boolean;
}): string | undefined {
  if (!input.record) return 'No worktree with that id. Call list to see the current ids.';
  if (input.dirtyFiles.length === 0 || input.force) return undefined;
  // Naming the files is the point: "the tree is dirty" sends the reader to go
  // look, and the answer is usually a file they forgot rather than one they
  // meant to keep.
  const names = input.dirtyFiles.slice(0, 10).join(', ');
  const more = input.dirtyFiles.length > 10 ? `, and ${String(input.dirtyFiles.length - 10)} more` : '';
  return `${String(input.dirtyFiles.length)} uncommitted file(s): ${names}${more}. Pass force: true to discard them.`;
}

export interface Reconciliation {
  records: WorktreeRecord[];
  /** Ids whose status changed, so a caller can report what it noticed. */
  changed: string[];
}

/**
 * Marks records whose process or directory is gone as orphaned.
 *
 * Nothing is deleted here. A doompi-git orphan owns a directory that may hold
 * uncommitted work, so losing the record would lose the only pointer to it.
 * Deletion is always a separate, named decision.
 */
export function reconcile(
  records: readonly WorktreeRecord[],
  probe: { alive: (record: WorktreeRecord) => boolean; exists: (path: string) => boolean },
): Reconciliation {
  const changed: string[] = [];
  const next = records.map((record) => {
    if (record.status === 'orphaned') return record;
    const gone = !probe.exists(record.path) || !probe.alive(record);
    if (!gone) return record;
    changed.push(record.id);
    return { ...record, status: 'orphaned' as const };
  });
  return { records: next, changed };
}

export interface PrunePlan {
  /** Orphans whose directory git still lists, safe to remove. */
  remove: WorktreeRecord[];
  /** Orphans whose directory is already gone; drop the record only. */
  forget: WorktreeRecord[];
  /** Paths git lists under our root that we have no record of; report, never touch. */
  untracked: string[];
  /** Orphans left alone because they still hold uncommitted work. */
  keptDirty: WorktreeRecord[];
  /**
   * Branches git refused to delete because they hold commits.
   *
   * Filled by the prune itself, not by the plan: a dry run destroys nothing, so
   * it has nothing to report here and leaves it empty.
   */
  keptBranches: string[];
}

/**
 * What a prune would do, decided before anything is destroyed.
 *
 * Separating the plan from the execution is what makes dryRun honest and lets
 * the destructive half be reviewed on its own.
 */
export function planPrune(input: {
  records: readonly WorktreeRecord[];
  gitPaths: readonly string[];
  worktreesRoot: string;
  dirtyByPath: ReadonlyMap<string, readonly string[]>;
}): PrunePlan {
  const plan: PrunePlan = { remove: [], forget: [], untracked: [], keptDirty: [], keptBranches: [] };
  const known = new Set(input.records.map((record) => record.path));
  const listed = new Set(input.gitPaths);
  for (const record of input.records) {
    if (record.status !== 'orphaned') continue;
    if (!listed.has(record.path)) {
      plan.forget.push(record);
      continue;
    }
    if ((input.dirtyByPath.get(record.path) ?? []).length > 0) {
      plan.keptDirty.push(record);
      continue;
    }
    plan.remove.push(record);
  }
  for (const path of input.gitPaths) {
    // Only ever inside our own root: a worktree the user made by hand is none
    // of this package's business, even when it looks abandoned.
    if (path.startsWith(`${input.worktreesRoot}/`) && !known.has(path)) plan.untracked.push(path);
  }
  return plan;
}
