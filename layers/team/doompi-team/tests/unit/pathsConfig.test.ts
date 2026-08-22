import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getAgentDir,
  getConfigDirName,
  getProjectConfigDir,
  PI_CODING_AGENT_PACKAGE_ROOT_ENV,
  resetConfigDirNameCache,
  resolveChildCwd,
  resolveConfigDirName,
  resolveWatchPath,
} from '../../src/adapters/filesystem/configDir';
import {
  createSessionScope,
  currentResultsDir,
  currentRunsDir,
  getRunConfigPath,
  scopeResultsDir,
  scopeRunsDir,
  scopeTeamDir,
  SESSIONS_ROOT_DIR,
  sessionScopeDir,
  sessionScopeKey,
  resolveTempScopeId,
  TEMP_ROOT_DIR,
} from '../../src/adapters/filesystem/paths';

const temporaryDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-paths-'));
  temporaryDirs.push(dir);
  return dir;
}

/** A package root the resolver will accept, with an optional configDir. */
function writeCodingAgentPackage(configDir: string | undefined): string {
  const dir = makeTempDir();
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      ...(configDir === undefined ? {} : { piConfig: { configDir } }),
    }),
  );
  return dir;
}

afterEach(() => {
  resetConfigDirNameCache();
  delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveTempScopeId', () => {
  it('prefers the uid, which the environment cannot spoof', () => {
    const id = resolveTempScopeId({ getuid: () => 501, env: { USER: 'someone-else' } });
    expect(id).toBe('uid-501');
  });

  it('falls back to the environment when there is no uid', () => {
    expect(resolveTempScopeId({ getuid: undefined, env: { USER: 'ada' } })).toBe('user-ada');
  });

  it('prefers USERNAME over USER over LOGNAME', () => {
    const env = { USERNAME: 'first', USER: 'second', LOGNAME: 'third' };
    expect(resolveTempScopeId({ getuid: undefined, env })).toBe('user-first');
    expect(resolveTempScopeId({ getuid: undefined, env: { USER: 'second', LOGNAME: 'third' } })).toBe('user-second');
    expect(resolveTempScopeId({ getuid: undefined, env: { LOGNAME: 'third' } })).toBe('user-third');
  });

  it('cannot be made to traverse out of the temp root', () => {
    const id = resolveTempScopeId({ getuid: undefined, env: { USER: '../../etc/passwd' } });

    // Separators are stripped, so the result is always a single segment. Dots
    // survive, but the mandatory `user-` prefix means the segment can never be
    // `.` or `..`, which is what would actually traverse.
    expect(id).toBe('user-..-..-etc-passwd');
    expect(id).not.toContain('/');
    expect(id).not.toContain(path.sep);
    expect(path.join(os.tmpdir(), id)).toBe(path.join(os.tmpdir(), 'user-..-..-etc-passwd'));
  });

  it('cannot produce a bare dot segment even from a dot-only name', () => {
    expect(resolveTempScopeId({ getuid: undefined, env: { USER: '..' } })).toBe('user-..');
    expect(resolveTempScopeId({ getuid: undefined, env: { USER: '.' } })).toBe('user-.');
  });

  it('never yields an empty segment', () => {
    expect(resolveTempScopeId({ getuid: undefined, env: { USER: '///' } })).toBe('user-unknown');
  });

  it('uses os.userInfo when the environment is bare', () => {
    const id = resolveTempScopeId({ getuid: undefined, env: {}, userInfo: () => ({ username: 'grace' }) });
    expect(id).toBe('user-grace');
  });

  it('falls back to the home directory when userInfo throws', () => {
    const id = resolveTempScopeId({
      getuid: undefined,
      env: { HOME: '/home/ada' },
      userInfo: () => {
        throw new Error('no passwd entry');
      },
    });
    // The leading separator becomes a dash, which the trim then removes.
    expect(id).toBe('home-home-ada');
  });

  it('reaches the shared scope only when every source fails', () => {
    const id = resolveTempScopeId({
      getuid: undefined,
      env: {},
      userInfo: () => ({ username: null }),
      homedir: () => {
        throw new Error('no home');
      },
    });
    expect(id).toBe('shared');
  });
});

describe('filesystem roots', () => {
  it('names the root for this package, not its predecessor', () => {
    expect(path.basename(TEMP_ROOT_DIR).startsWith('doom-team-')).toBe(true);
    expect(TEMP_ROOT_DIR).not.toContain('pi-subagents');
  });

  it('scopes the root per user so a shared tmpdir cannot collide', () => {
    expect(path.basename(TEMP_ROOT_DIR)).toBe(`doom-team-${resolveTempScopeId()}`);
    expect(path.dirname(TEMP_ROOT_DIR)).toBe(os.tmpdir());
  });

  it('puts every session under one sessions root, not loose in the temp root', () => {
    expect(path.dirname(SESSIONS_ROOT_DIR)).toBe(TEMP_ROOT_DIR);
    const scope = createSessionScope('session-under-test');
    expect(path.dirname(sessionScopeDir(scope))).toBe(SESSIONS_ROOT_DIR);
  });

  it("derives every per-session directory from that session's own scope", () => {
    const scope = createSessionScope('session-under-test');
    const scopeDir = sessionScopeDir(scope);
    for (const dir of [scopeResultsDir(scope), scopeRunsDir(scope), scopeTeamDir(scope)]) {
      expect(path.dirname(dir)).toBe(scopeDir);
    }
  });

  it('keeps the per-session subdirectories distinct', () => {
    const scope = createSessionScope('session-under-test');
    const dirs = [scopeResultsDir(scope), scopeRunsDir(scope), scopeTeamDir(scope)];
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('gives two sessions completely disjoint trees, which is the point', () => {
    const first = sessionScopeDir(createSessionScope('session-one'));
    const second = sessionScopeDir(createSessionScope('session-two'));
    expect(first).not.toBe(second);
    expect(first.startsWith(second)).toBe(false);
    expect(second.startsWith(first)).toBe(false);
  });

  it('hashes the session id rather than sanitizing it, so two ids cannot collide on one directory', () => {
    // Sanitizing would map both of these onto the same segment.
    expect(sessionScopeKey('a/b')).not.toBe(sessionScopeKey('a:b'));
    expect(sessionScopeKey('x')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('places a run config inside its own session, not at the shared root', () => {
    const scope = createSessionScope('session-under-test');
    const configPath = getRunConfigPath(scope, 'abc123');
    expect(configPath).toBe(path.join(sessionScopeDir(scope), 'launch', 'abc123.json'));
    expect(path.dirname(configPath)).not.toBe(TEMP_ROOT_DIR);
  });

  it('resolves the current-scope helpers against the scope the process has adopted', () => {
    // tests/setup.ts installs a per-worker scope; these must agree with it.
    expect(path.dirname(currentRunsDir())).toBe(path.dirname(currentResultsDir()));
  });
});

describe('resolveConfigDirName', () => {
  it("prefers the loaded module's own export", () => {
    expect(resolveConfigDirName({ CONFIG_DIR_NAME: '.custom' })).toBe('.custom');
  });

  it('ignores a blank or non-string module export', () => {
    const packageRoot = writeCodingAgentPackage('.fromroot');
    expect(resolveConfigDirName({ CONFIG_DIR_NAME: '   ' }, undefined, packageRoot)).toBe('.fromroot');
    expect(resolveConfigDirName({ CONFIG_DIR_NAME: 42 }, undefined, packageRoot)).toBe('.fromroot');
  });

  it('reads the configured package root', () => {
    const packageRoot = writeCodingAgentPackage('.rebranded');
    expect(resolveConfigDirName(undefined, undefined, packageRoot)).toBe('.rebranded');
  });

  it('ignores a package root belonging to a different package', () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'something-else', piConfig: { configDir: '.nope' } }),
    );
    expect(resolveConfigDirName(undefined, undefined, dir)).toBe('.pi');
  });

  it('walks upward from the entry point', () => {
    const packageRoot = writeCodingAgentPackage('.walked');
    const nested = path.join(packageRoot, 'dist', 'bin');
    fs.mkdirSync(nested, { recursive: true });
    const entryPoint = path.join(nested, 'cli.js');
    fs.writeFileSync(entryPoint, '');

    expect(resolveConfigDirName(undefined, entryPoint)).toBe('.walked');
  });

  it('defaults to .pi when nothing declares a name', () => {
    expect(resolveConfigDirName(undefined, undefined, makeTempDir())).toBe('.pi');
  });

  it('defaults to .pi when the manifest is malformed', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), 'not json');
    expect(resolveConfigDirName(undefined, undefined, dir)).toBe('.pi');
  });

  it('defaults to .pi when the package declares no configDir', () => {
    expect(resolveConfigDirName(undefined, undefined, writeCodingAgentPackage(undefined))).toBe('.pi');
  });
});

describe('getConfigDirName', () => {
  it('resolves once and reuses the answer', () => {
    process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = writeCodingAgentPackage('.memoized');
    expect(getConfigDirName()).toBe('.memoized');

    // The installation cannot change under a live process, so a later env
    // change must not be observed until the cache is explicitly reset.
    process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = writeCodingAgentPackage('.changed');
    expect(getConfigDirName()).toBe('.memoized');

    resetConfigDirNameCache();
    expect(getConfigDirName()).toBe('.changed');
  });

  it('builds the project config dir from the resolved name', () => {
    process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = writeCodingAgentPackage('.proj');
    expect(getProjectConfigDir('/repo')).toBe(path.join('/repo', '.proj'));
  });
});

describe('getAgentDir', () => {
  const original = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  });

  it('expands a bare tilde to the home directory', () => {
    process.env.PI_CODING_AGENT_DIR = '~';
    expect(getAgentDir()).toBe(os.homedir());
  });

  it('expands a tilde prefix', () => {
    process.env.PI_CODING_AGENT_DIR = '~/agents';
    expect(getAgentDir()).toBe(path.join(os.homedir(), 'agents'));
  });

  it('uses an absolute override as given', () => {
    process.env.PI_CODING_AGENT_DIR = '/opt/agents';
    expect(getAgentDir()).toBe('/opt/agents');
  });

  it('defaults under the home config directory', () => {
    delete process.env.PI_CODING_AGENT_DIR;
    process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = writeCodingAgentPackage('.dflt');
    expect(getAgentDir()).toBe(path.join(os.homedir(), '.dflt', 'agent'));
  });
});

describe('resolveChildCwd', () => {
  it('inherits the parent cwd when the child declares none', () => {
    expect(resolveChildCwd('/base', undefined)).toBe('/base');
  });

  it('keeps an absolute child cwd', () => {
    expect(resolveChildCwd('/base', '/elsewhere')).toBe('/elsewhere');
  });

  it('resolves a relative child cwd against the parent', () => {
    expect(resolveChildCwd('/base', 'sub/dir')).toBe(path.resolve('/base', 'sub/dir'));
  });
});

describe('resolveWatchPath', () => {
  it('resolves through to the real path', () => {
    expect(resolveWatchPath('/short/path', () => '/real/long/path')).toBe('/real/long/path');
  });

  it('falls back to the given path when it cannot be resolved', () => {
    expect(
      resolveWatchPath('/not/yet/created', () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
    ).toBe('/not/yet/created');
  });
});
