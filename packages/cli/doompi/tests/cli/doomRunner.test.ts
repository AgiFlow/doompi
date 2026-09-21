import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from '../../src/bin/doomRunner';

const originalDirectory = process.cwd();
const temporaryRoots: string[] = [];

function makeRepository(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-shim-')));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, '.doom'));
  return root;
}

function installRunner(root: string): void {
  const packageRoot = path.join(root, '.pi', 'npm', 'node_modules', '@agimon-ai', 'doompi-runner');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@agimon-ai/doompi-runner',
      type: 'module',
      exports: { './bin/cli': { import: './cli.mjs' } },
    }),
  );
  fs.writeFileSync(
    path.join(packageRoot, 'cli.mjs'),
    "export async function main(argv) { return argv.join(':') === 'list:--json' ? 23 : 24; }\n",
  );
}

afterEach(() => {
  process.chdir(originalDirectory);
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('doom-runner compatibility shim', () => {
  it('remains importable when the caller has no file entrypoint', () => {
    const entry = new URL('../../dist/bin/doomRunner.mjs', import.meta.url).href;
    const root = makeRepository();
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `process.argv[1] = 'missing-entrypoint'; await import(${JSON.stringify(entry)}); console.log('imported');`,
      ],
      { cwd: root, encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('imported\n');
  });

  it('runs the built entrypoint through an installed-style symlink instead of silently exiting', () => {
    const root = makeRepository();
    installRunner(root);
    const executable = path.join(root, 'doom-runner');
    fs.symlinkSync(new URL('../../dist/bin/doomRunner.mjs', import.meta.url), executable);
    const result = spawnSync(process.execPath, [executable, 'list', '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(23);
  });

  it('delegates to Runner from the repository-managed package store', async () => {
    const root = makeRepository();
    installRunner(root);
    const nested = path.join(root, 'src');
    fs.mkdirSync(nested);
    process.chdir(nested);

    await expect(main(['list', '--json'])).resolves.toBe(23);
  });

  it('does not retain Runner through the DoomPi package closure', async () => {
    const root = makeRepository();
    process.chdir(root);

    await expect(main([])).rejects.toThrow('Add @agimon-ai/doompi-runner to .doom/modes.yaml and run doompi sync.');
  });
});
