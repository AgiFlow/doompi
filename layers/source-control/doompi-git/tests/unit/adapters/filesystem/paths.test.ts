import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doomGitRoot, hubRegistryDir, registryFile, worktreesRoot } from '../../../../src/adapters/filesystem/paths.ts';

const ENV_NAME = 'DOOMPI_RUNTIME_DIR';
const HOME = '/home/tester';

describe('doomGitRoot and worktreesRoot', () => {
  it('keep this package state outside any checkout', () => {
    expect(doomGitRoot(HOME)).toBe(path.join(HOME, '.pi', '.doom', 'git'));
    expect(worktreesRoot(HOME)).toBe(path.join(HOME, '.pi', '.doom', 'git', 'worktrees'));
  });
});

describe('registryFile', () => {
  it('keys one registry file per repository by label and id', () => {
    const file = registryFile('/tmp/Some Repo', HOME);
    const key = path.basename(path.dirname(file));

    expect(file.startsWith(path.join(doomGitRoot(HOME), 'registry'))).toBe(true);
    expect(path.basename(file)).toBe('worktrees.json');
    expect(key).toMatch(/^some-repo--[0-9a-f]{12}$/u);
  });
});

describe('hubRegistryDir', () => {
  it('prefers the flag over the env var and the home default', () => {
    // The hub passes --registry-dir to its children and also exports the env
    // var, so the flag has to win or a child watches the wrong directory.
    const resolved = hubRegistryDir(
      ['node', 'server.mjs', '--registry-dir', '/run/from-flag'],
      { [ENV_NAME]: '/run/from-env' },
      HOME,
    );
    expect(resolved).toBe('/run/from-flag');
  });

  it('prefers the env var over the home default when there is no flag', () => {
    expect(hubRegistryDir(['node', 'server.mjs'], { [ENV_NAME]: '/run/from-env' }, HOME)).toBe('/run/from-env');
  });

  it('falls back to the home default when neither is given', () => {
    expect(hubRegistryDir(['node', 'server.mjs'], {}, HOME)).toBe(`${HOME}/.doompi/run`);
  });

  it('ignores a trailing flag with no value', () => {
    expect(hubRegistryDir(['node', 'server.mjs', '--registry-dir'], { [ENV_NAME]: '/run/from-env' }, HOME)).toBe(
      '/run/from-env',
    );
    expect(hubRegistryDir(['node', 'server.mjs', '--registry-dir'], {}, HOME)).toBe(`${HOME}/.doompi/run`);
  });
});
