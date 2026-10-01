import { execFile } from 'node:child_process';
import fs from 'node:fs';

import type { GitBranches, GitLocalBranch, GitRemoteBranch } from '../../types/gitSessions';
import type { WorktreeGit } from '../../types/worktreeRegistry';

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
export const READ_TIMEOUT_MS = 30_000;
const ADD_TIMEOUT_MS = 300_000;
const REMOVE_TIMEOUT_MS = 300_000;
const PRUNE_TIMEOUT_MS = 15_000;
/** fetch and push: bounded by the network, so long enough for a slow link, short enough to notice a dead one. */
export const NETWORK_TIMEOUT_MS = 120_000;
/** A rebase replays commits locally; a large branch on a slow disk takes minutes, never hours. */
export const REBASE_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1_000_000;
/** Enough for any branch picker; a repository with more refs lists its most recent ones. */
const MAX_LISTED_REFS = 2_000;
const LOCAL_PREFIX = 'refs/heads/';
const REMOTE_PREFIX = 'refs/remotes/';
const HEAD_SUFFIX = '/HEAD';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The timeout killed git. */
  timedOut: boolean;
  /** Output passed maxBuffer and git was killed; stdout is truncated. */
  overflow: boolean;
}

export interface RunGitOptions {
  timeout: number;
  /** The whole environment for this one child. Defaults to the hub's own. */
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

/**
 * Runs git and reports the outcome without ever throwing on a non-zero exit.
 *
 * LC_ALL is pinned because callers decide what to do by matching git's own
 * wording, and a translated message would silently turn a recognised
 * condition into an unrecognised failure.
 *
 * `env` replaces the environment for this child only. That is how remote auth
 * reaches fetch and push without ever touching the hub's own process.env,
 * which every session started afterwards would inherit.
 */
export function runGit(cwd: string, args: readonly string[], options: RunGitOptions): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer ?? MAX_OUTPUT_BYTES,
        env: { ...(options.env ?? process.env), LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null;
        const code = failure && typeof failure.code === 'number' ? failure.code : failure ? 1 : 0;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: failure?.killed === true && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          overflow: failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      },
    );
  });
}

function git(cwd: string, args: readonly string[], timeout: number): Promise<GitResult> {
  return runGit(cwd, args, { timeout });
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

    async addExistingWorktree({ repositoryRoot, path, branch, remote }) {
      const args =
        remote === undefined
          ? ['worktree', 'add', path, branch]
          : ['worktree', 'add', '--track', '-b', branch, path, `${remote}/${branch}`];
      const result = await git(repositoryRoot, args, ADD_TIMEOUT_MS);
      if (result.code !== 0) throw failure('worktree add', result);
    },

    async listBranches(repositoryRoot): Promise<GitBranches> {
      const refs = await git(
        repositoryRoot,
        [
          'for-each-ref',
          '--sort=-committerdate',
          `--count=${String(MAX_LISTED_REFS)}`,
          '--format=%(refname)%09%(worktreepath)%09%(symref)',
          'refs/heads',
          'refs/remotes',
        ],
        READ_TIMEOUT_MS,
      );
      if (refs.code !== 0) throw failure('for-each-ref', refs);
      const local: GitLocalBranch[] = [];
      const remotes: GitRemoteBranch[] = [];
      for (const line of refs.stdout.split('\n')) {
        const [ref = '', worktreePath = '', symref = ''] = line.split('\t');
        if (ref === '' || symref !== '') continue;
        if (ref.startsWith(LOCAL_PREFIX)) {
          const name = ref.slice(LOCAL_PREFIX.length);
          local.push(worktreePath === '' ? { name } : { name, checkedOutAt: worktreePath });
        } else if (ref.startsWith(REMOTE_PREFIX) && !ref.endsWith(HEAD_SUFFIX)) {
          const rest = ref.slice(REMOTE_PREFIX.length);
          const separator = rest.indexOf('/');
          if (separator > 0) remotes.push({ remote: rest.slice(0, separator), name: rest.slice(separator + 1) });
        }
      }
      const localNames = new Set(local.map((branch) => branch.name));
      const head = await git(repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], READ_TIMEOUT_MS);
      const current = head.code === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : undefined;
      const origin = await git(
        repositoryRoot,
        ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        READ_TIMEOUT_MS,
      );
      const defaultBase = origin.code === 0 && origin.stdout.trim() !== '' ? origin.stdout.trim() : current;
      return {
        ...(current === undefined ? {} : { current }),
        ...(defaultBase === undefined ? {} : { defaultBase }),
        local,
        remote: remotes.filter((branch) => !localNames.has(branch.name)),
      };
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

    async deleteBranch({ repositoryRoot, branch }) {
      // -d, never -D: git refuses a branch that still holds unmerged commits,
      // and that refusal is the whole safety property. A rollback that could
      // throw away work someone committed in the worktree is worse than a
      // branch left behind.
      const result = await git(repositoryRoot, ['branch', '-d', branch], READ_TIMEOUT_MS);
      return result.code === 0;
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

    async remoteBaseRef(cwd) {
      const upstream = await git(
        cwd,
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        READ_TIMEOUT_MS,
      );
      if (upstream.code === 0) {
        const branch = upstream.stdout.trim();
        if (branch !== '') return branch;
      }
      const origin = await git(
        cwd,
        ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        READ_TIMEOUT_MS,
      );
      if (origin.code === 0) {
        const branch = origin.stdout.trim();
        if (branch !== '') return branch;
      }
      const defaults = await git(cwd, ['for-each-ref', '--format=%(symref:short)', 'refs/remotes'], READ_TIMEOUT_MS);
      if (defaults.code !== 0) return undefined;
      return defaults.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '');
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
