import os from 'node:os';
import path from 'node:path';

import { REGISTRY_DIR_ENV, resolveRegistryDir } from '@agimon-ai/doompi-core/web';

import { repositoryId, repositoryLabel } from '../repositoryIdentity';

const REGISTRY_DIR_FLAG = '--registry-dir';

/**
 * Where this package keeps its own state.
 *
 * Outside the repository on purpose. A worktree directory inside the checkout
 * would be found by every glob the repository's own tooling runs, and would
 * resolve workspace imports against the parent checkout rather than the
 * worktree, so a session there would build the wrong source while appearing to
 * work.
 */
export function doomGitRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.pi', '.doom', 'git');
}

/** The directory every worktree for every repository is created under. */
export function worktreesRoot(homeDir: string = os.homedir()): string {
  return path.join(doomGitRoot(homeDir), 'worktrees');
}

/** One registry file per repository, keyed by the shared git directory. */

export function registryFile(repositoryRoot: string, homeDir: string = os.homedir()): string {
  const key = `${repositoryLabel(repositoryRoot)}--${repositoryId(repositoryRoot)}`;
  return path.join(doomGitRoot(homeDir), 'registry', key, 'worktrees.json');
}

/**
 * The session registry directory this process's hub is watching.
 *
 * A spawned session only appears in the rail if it registers in the same
 * directory the hub watches, and the hub passes that directory to its children
 * as `--registry-dir` while also inheriting the env var. Recovering it from
 * this process's own argv and env, in the same precedence the hub and the
 * session server use, is what makes a worktree session visible rather than
 * silently invisible.
 */
export function hubRegistryDir(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const index = argv.indexOf(REGISTRY_DIR_FLAG);
  const flagValue = index >= 0 ? argv[index + 1] : undefined;
  return resolveRegistryDir({
    ...(flagValue === undefined ? {} : { flagValue }),
    ...(env[REGISTRY_DIR_ENV] === undefined ? {} : { envValue: env[REGISTRY_DIR_ENV] }),
    homeDir,
  });
}
