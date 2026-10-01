import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Throwaway repositories and bare remotes, isolated from this machine's git
 * config: no system config, a private global one with an identity and no
 * signing, so a clean CI box and a developer laptop behave the same.
 */
export interface GitSandbox {
  root: string;
  /** The environment every git call here runs with. Pass it to services as their base env. */
  env: NodeJS.ProcessEnv;
  git(cwd: string, ...args: string[]): string;
  /** A repository with one commit on main. */
  repository(name: string): string;
  /** A bare remote seeded from `source`'s main, with `source` tracking it as origin. */
  remote(source: string, name: string): string;
  clone(remote: string, name: string): string;
  commit(cwd: string, file: string, contents: string, message: string): void;
  dispose(): void;
}

export function createGitSandbox(prefix = 'doompi-git-sandbox-'): GitSandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(
    globalConfig,
    [
      '[user]',
      '\temail = test@example.com',
      '\tname = Test',
      '[commit]',
      '\tgpgsign = false',
      '[init]',
      '\tdefaultBranch = main',
      '[advice]',
      '\tskippedCherryPicks = false',
      '',
    ].join('\n'),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env });
  const commit = (cwd: string, file: string, contents: string, message: string): void => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), contents);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', message);
  };
  return {
    root,
    env,
    git,
    commit,
    repository(name) {
      const created = path.join(root, name);
      fs.mkdirSync(created, { recursive: true });
      git(created, 'init', '-q', '-b', 'main');
      commit(created, 'README.md', '# repo\n', 'initial');
      return created;
    },
    remote(source, name) {
      const bare = path.join(root, `${name}.git`);
      git(root, 'init', '-q', '--bare', '-b', 'main', bare);
      git(source, 'remote', 'add', 'origin', bare);
      git(source, 'push', '-q', '-u', 'origin', 'main');
      git(source, 'remote', 'set-head', 'origin', 'main');
      return bare;
    },
    clone(remote, name) {
      const target = path.join(root, name);
      git(root, 'clone', '-q', remote, target);
      return target;
    },
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
