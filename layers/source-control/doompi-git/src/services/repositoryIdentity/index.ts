import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ID_LENGTH = 12;
const MAX_LABEL_LENGTH = 32;

/**
 * The git directory shared by a repository and all of its worktrees.
 *
 * A normal checkout has a `.git` directory. A linked worktree has a `.git`
 * FILE pointing at `<common>/worktrees/<name>`, whose `commondir` points back
 * at the shared directory. Following that chain is what makes every worktree of
 * one repository agree on the repository's identity, which matters here because
 * the registry is per repository and must be found from inside a worktree too.
 */
export function gitCommonDirectory(root: string): string | undefined {
  const marker = path.join(root, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(marker);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) return marker;
  let pointer: string;
  try {
    pointer = fs.readFileSync(marker, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (!pointer.startsWith('gitdir:')) return undefined;
  const gitDir = path.resolve(root, pointer.slice('gitdir:'.length).trim());
  try {
    const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    return path.resolve(gitDir, common);
  } catch {
    // A submodule's .git file has no commondir; its gitdir is already common.
    return gitDir;
  }
}

/** A directory name that is recognisable to a person and safe on a filesystem. */
export function repositoryLabel(root: string): string {
  const label = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_LABEL_LENGTH);
  return label === '' ? 'repository' : label;
}

/**
 * A stable id for the repository a directory belongs to.
 *
 * Keyed on the common git directory rather than the given path, so the main
 * checkout and every worktree of it resolve to one id and therefore to one
 * registry. Falling back to the path keeps a non-repository directory usable
 * instead of failing, though nothing here should reach that case.
 */
export function repositoryId(root: string): string {
  const common = gitCommonDirectory(root);
  const token = common === undefined ? `root:${path.resolve(root)}` : `git:${common}`;
  return createHash('sha256').update(token).digest('hex').slice(0, ID_LENGTH);
}

/** A short, collision-resistant suffix for one worktree directory. */
export function shortId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 8);
}
