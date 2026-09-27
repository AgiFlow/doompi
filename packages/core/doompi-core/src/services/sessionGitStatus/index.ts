import { execFile } from 'node:child_process';

import type { SessionGitStatus } from './type';

const GIT_TIMEOUT_MS = 5_000;
const BRANCH_HEAD_PREFIX = '# branch.head ';
const BRANCH_OID_PREFIX = '# branch.oid ';
const DETACHED_HEAD = '(detached)';
const SHORT_OID_LENGTH = 7;

/**
 * Reads the branch and dirty flag for a session cwd with one `git status` call.
 * Resolves undefined when the cwd is not a git work tree or git is unavailable,
 * which the session summary documents as "no git status".
 */
export function readSessionGitStatus(cwd: string): Promise<SessionGitStatus | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        let head: string | undefined;
        let oid: string | undefined;
        let dirty = false;
        for (const line of stdout.split('\n')) {
          if (line.startsWith(BRANCH_HEAD_PREFIX)) head = line.slice(BRANCH_HEAD_PREFIX.length).trim();
          else if (line.startsWith(BRANCH_OID_PREFIX)) oid = line.slice(BRANCH_OID_PREFIX.length).trim();
          else if (line !== '' && !line.startsWith('#')) dirty = true;
        }
        const branch = head === DETACHED_HEAD ? oid?.slice(0, SHORT_OID_LENGTH) : head;
        resolve(branch ? { branch, dirty } : undefined);
      },
    );
  });
}
