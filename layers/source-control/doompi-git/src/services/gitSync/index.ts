import fs from 'node:fs';
import path from 'node:path';

import { resolveBaseRef } from '../branchDiff';
import { DoomGitExpectedError } from '../errors';
import { remoteEnv } from '../gitAuth';
import { NETWORK_TIMEOUT_MS, READ_TIMEOUT_MS, REBASE_TIMEOUT_MS, runGit } from '../gitCli';
import { classifyGitFailure } from '../gitFailure';
import type { GitSync, GitSyncContext, GitSyncOptions, GitSyncOutcome } from './type';

/**
 * Manual pull, push and rebase for a session's checkout.
 *
 * DESIGN PATTERNS:
 * - The workspace's auth goes into the environment of the one fetch or push
 *   that needs it, built fresh per call. Rebase itself runs locally and never
 *   sees a credential.
 * - Fetch and rebase are separate commands, so a hung network can never leave a
 *   rebase half applied.
 * - A conflicted rebase is not an error. It is left paused for the reader to
 *   hand to the agent or abort, and git's own state reports it from then on.
 * - Pull and rebase refuse uncommitted tracked changes rather than stash them.
 *   Untracked files only block when git says they would be overwritten.
 * - Push never forces on its own. A rejection comes back as `push_needs_force`,
 *   and only a confirmed retry sends `--force-with-lease --force-if-includes`,
 *   which git refuses if the remote holds commits this branch never integrated.
 */

const DONE: GitSyncOutcome = { outcome: 'done' };

function expected(
  code: ConstructorParameters<typeof DoomGitExpectedError>[0],
  message: string,
  recovery: string,
): DoomGitExpectedError {
  return new DoomGitExpectedError(code, message, false, recovery);
}

async function readLine(cwd: string, args: readonly string[]): Promise<string | undefined> {
  const result = await runGit(cwd, args, { timeout: READ_TIMEOUT_MS });
  const out = result.stdout.trim();
  return result.code === 0 && out !== '' ? out : undefined;
}

async function toplevel(cwd: string): Promise<string> {
  const root = await readLine(cwd, ['rev-parse', '--show-toplevel']);
  if (root === undefined)
    throw expected(
      'not_a_repository',
      'This session is not in a git checkout.',
      'Open the session in a git repository.',
    );
  return root;
}

async function rebasing(root: string): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const gitPath = await readLine(root, ['rev-parse', '--git-path', name]);
    if (gitPath !== undefined && fs.existsSync(path.resolve(root, gitPath))) return true;
  }
  return false;
}

async function conflicts(root: string): Promise<string[]> {
  const result = await runGit(root, ['diff', '--name-only', '--diff-filter=U', '-z'], { timeout: READ_TIMEOUT_MS });
  return result.stdout.split('\0').filter((file) => file !== '');
}

async function currentBranch(root: string): Promise<string> {
  const branch = await readLine(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch === undefined) {
    throw expected('detached_head', 'HEAD is detached, so there is no branch to sync.', 'Check out a branch first.');
  }
  return branch;
}

async function guard(root: string, needsCleanTree: boolean): Promise<string> {
  if (await rebasing(root)) {
    throw expected(
      'rebase_in_progress',
      'A rebase is paused in this checkout.',
      'Ask the agent to resolve it, or abort the rebase.',
    );
  }
  const branch = await currentBranch(root);
  if (needsCleanTree) {
    const dirty = await readLine(root, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty !== undefined)
      throw expected('worktree_dirty', 'There are uncommitted changes.', 'Commit or stash your changes first.');
  }
  return branch;
}

export function createGitSync(options: GitSyncOptions): GitSync {
  const baseEnv = options.baseEnv ?? process.env;

  /** One credentialed network command against `remote`, classified on failure. */
  const network = async (
    root: string,
    context: GitSyncContext,
    remote: string,
    operation: string,
    args: readonly string[],
    urlArgs: readonly string[] = [],
  ): Promise<void> => {
    const url = await readLine(root, ['remote', 'get-url', ...urlArgs, remote]);
    if (url === undefined)
      throw expected('no_remote', `There is no remote named ${remote}.`, 'Add the remote in a terminal first.');
    const prepared = remoteEnv(context.auth, url, baseEnv, options.homeDir);
    const result = await runGit(root, args, { timeout: NETWORK_TIMEOUT_MS, env: prepared.env });
    if (result.code !== 0) throw classifyGitFailure(operation, result, prepared.mismatch);
  };

  /** Rebases onto `onto`; a stop on conflicts leaves the rebase paused and says so. */
  const rebaseOnto = async (root: string, onto: string): Promise<GitSyncOutcome> => {
    const result = await runGit(root, ['rebase', onto], {
      timeout: REBASE_TIMEOUT_MS,
      env: { ...baseEnv, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.code === 0) return DONE;
    if (await rebasing(root)) return { outcome: 'paused', conflicts: await conflicts(root) };
    throw classifyGitFailure('rebase', result);
  };

  /** The remote a ref like `origin/main` or `refs/remotes/origin/main` belongs to. */
  const remoteOfRef = async (root: string, ref: string): Promise<string | undefined> => {
    const full = await readLine(root, ['rev-parse', '--symbolic-full-name', ref]);
    if (full === undefined || !full.startsWith('refs/remotes/')) return undefined;
    const rest = full.slice('refs/remotes/'.length);
    const cut = rest.indexOf('/');
    return cut > 0 ? rest.slice(0, cut) : undefined;
  };

  return {
    async pull(context) {
      const root = await toplevel(context.cwd);
      const branch = await guard(root, true);
      const remote = await readLine(root, ['config', `branch.${branch}.remote`]);
      const upstream = await readLine(root, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        `${branch}@{upstream}`,
      ]);
      if (remote === undefined || upstream === undefined) {
        throw expected('no_upstream', `${branch} has no upstream to pull from.`, 'Push once to set an upstream.');
      }
      // A branch tracking another local branch has nothing to fetch.
      if (remote !== '.') await network(root, context, remote, 'fetch', ['fetch', '--prune', remote]);
      return rebaseOnto(root, upstream);
    },

    async push(context, force) {
      const root = await toplevel(context.cwd);
      const branch = await guard(root, false);
      const configuredRemote = await readLine(root, ['config', `branch.${branch}.remote`]);
      const merge = await readLine(root, ['config', `branch.${branch}.merge`]);
      let remote = configuredRemote;
      let target = merge;
      const args = ['push', '--porcelain'];
      if (remote === undefined || target === undefined || remote === '.') {
        const remotes = ((await readLine(root, ['remote'])) ?? '').split('\n').filter((name) => name !== '');
        remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
        if (remote === undefined) {
          throw expected(
            'no_remote',
            'There is no remote to push to.',
            remotes.length === 0
              ? 'Add a remote in a terminal first.'
              : 'Push once from a terminal to choose the remote.',
          );
        }
        target = `refs/heads/${branch}`;
        args.push('--set-upstream');
      }
      if (force) args.push(`--force-with-lease=${target}`, '--force-if-includes');
      args.push(remote, `HEAD:${target}`);
      await network(root, context, remote, 'push', args, ['--push']);
      return DONE;
    },

    async rebase(context) {
      const root = await toplevel(context.cwd);
      const branch = await guard(root, true);
      const base = await resolveBaseRef(root, branch, context.recordedBaseRef);
      if (base === undefined)
        throw expected(
          'no_base',
          'No base branch to rebase onto.',
          'Fetch the remote, or create the worktree from a base.',
        );
      const remote = await remoteOfRef(root, base);
      if (remote !== undefined) await network(root, context, remote, 'fetch', ['fetch', '--prune', remote]);
      return rebaseOnto(root, base);
    },

    async abortRebase(context) {
      const root = await toplevel(context.cwd);
      if (!(await rebasing(root))) return DONE;
      const result = await runGit(root, ['rebase', '--abort'], { timeout: REBASE_TIMEOUT_MS });
      if (result.code !== 0) throw classifyGitFailure('rebase --abort', result);
      return DONE;
    },
  };
}
