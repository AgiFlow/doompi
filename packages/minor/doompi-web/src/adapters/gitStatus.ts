import { execFile } from 'node:child_process';
import type { SessionGitStatus } from '../types/hub.ts';

const GIT_TIMEOUT_MS = 2000;

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      // A non-repo cwd, missing git, or timeout all mean the same thing to the
      // rail: no branch chip.
      resolve(error ? undefined : stdout);
    });
  });
}

/**
 * Reads the branch chip for one session's working directory.
 *
 * Asks git itself rather than parsing .git/HEAD: worktrees (where .git is a
 * file) come free, and only git can answer whether the tree is dirty.
 */
export async function readGitStatus(cwd: string): Promise<SessionGitStatus | undefined> {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  if (!branch) return undefined;
  const status = await git(cwd, ['status', '--porcelain']);
  return { branch, dirty: status !== undefined && status.trim().length > 0 };
}
