import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/bin/doomRunner.ts';

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
