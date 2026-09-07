import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { WorktreeGit } from '../../types/worktreeRegistry.ts';

/**
 * Git, as this package needs it.
 *
 * The timeouts are not uniform because the operations are not comparable. A
 * read answers in milliseconds; `worktree add` copies an entire checkout and
 * `worktree remove` deletes one, both bounded by the filesystem rather than by
 * git, and both minutes rather than seconds on a large repository or on
 * Windows. A single timeout would either fail honest work or hang on a wedged
 * one.
 */
const READ_TIMEOUT_MS = 30_000;
const ADD_TIMEOUT_MS = 300_000;
const REMOVE_TIMEOUT_MS = 300_000;
const PRUNE_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1_000_000;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs git and reports the outcome without ever throwing on a non-zero exit.
 *
 * LC_ALL is pinned because two callers below decide what to do by matching
 * git's own wording, and a translated message would silently turn a recognised
 * condition into an unrecognised failure.
 */
function git(cwd: string, args: readonly string[], timeout: number): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout, maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * The message a failed git call is allowed to surface.
 *
 * Raw stderr never travels: it can carry a remote URL with a token in it, and
 * this text ends up in a tool result the model reads and may repeat.
 */
function failure(operation: string, result: GitResult): Error {
  return new Error(
    `git ${operation} failed (exit ${String(result.code)}, ${String(result.stderr.length)} bytes of stderr)`,
  );
}

/** Git's own words for "that worktree is not there any more". */
function missingWorktree(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return normalized.includes('is not a working tree') || normalized.includes('cannot remove working tree');
}

export function createWorktreeGit(): WorktreeGit {
  const prune = async (repositoryRoot: string): Promise<void> => {
    await git(repositoryRoot, ['worktree', 'prune'], PRUNE_TIMEOUT_MS);
  };

  return {
    async addWorktree({ repositoryRoot, path, branch, baseRef }) {
      const result = await git(repositoryRoot, ['worktree', 'add', '-b', branch, path, baseRef], ADD_TIMEOUT_MS);
      if (result.code !== 0) throw failure('worktree add', result);
    },

    async removeWorktree({ repositoryRoot, path, force }) {
      const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
      const result = await git(repositoryRoot, args, REMOVE_TIMEOUT_MS);
      if (result.code === 0) return;
      // A directory deleted behind git's back leaves an administrative entry
      // that makes a later `worktree add` at the same path refuse. Treating
      // "already gone" as success and pruning is what keeps that path reusable,
      // and it makes remove idempotent for a caller retrying after a crash.
      if (missingWorktree(result.stderr) && !fs.existsSync(path)) {
        await prune(repositoryRoot);
        return;
      }
      throw failure('worktree remove', result);
    },

    pruneWorktrees: prune,

    async listWorktreePaths(repositoryRoot) {
      const result = await git(repositoryRoot, ['worktree', 'list', '--porcelain'], READ_TIMEOUT_MS);
      if (result.code !== 0) return [];
      return result.stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length).trim())
        .filter((line) => line !== '');
    },

    async dirtyFiles(path) {
      const result = await git(path, ['status', '--porcelain'], READ_TIMEOUT_MS);
      if (result.code !== 0) return [];
      return result.stdout
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((line) => line !== '');
    },

    async repositoryRoot(cwd) {
      const result = await git(cwd, ['rev-parse', '--show-toplevel'], READ_TIMEOUT_MS);
      if (result.code !== 0) return undefined;
      const root = result.stdout.trim();
      return root === '' ? undefined : root;
    },

    async currentBranch(cwd) {
      const result = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], READ_TIMEOUT_MS);
      if (result.code !== 0) return undefined;
      const branch = result.stdout.trim();
      return branch === '' ? undefined : branch;
    },

    async mergeBranch({ repositoryRoot, branch, message }) {
      // --no-ff so the worktree's work stays identifiable as a unit after the
      // fact. A fast-forward would erase the fact that it was ever separate,
      // which is the one thing worth keeping about a worktree.
      const args = ['merge', '--no-ff', ...(message === undefined ? [] : ['-m', message]), branch];
      const result = await git(repositoryRoot, args, READ_TIMEOUT_MS);
      if (result.code === 0) return;
      // A conflicted merge leaves the parent mid-merge, which is a state the
      // person has to resolve; aborting for them would throw away the conflict
      // markers they need to see.
      throw failure('merge', result);
    },
  };
}
