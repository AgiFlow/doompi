import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultWorkspaceFolder } from '../../src/builders/server/defaultWorkspace';
import { findRepositoryRoot } from '../../src/composition/repository';

const homes: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-default-workspace-'));
  homes.push(home);
  // A global config folder makes ~/.pi a repository root, which is why the default folder needs git.
  fs.mkdirSync(path.join(home, '.pi', '.doom'), { recursive: true });
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('createDefaultWorkspaceFolder', () => {
  it('creates ~/.pi/.doom/workspace/<name> as a git repository that resolves to itself', async () => {
    const home = temporaryHome();
    const folder = await createDefaultWorkspaceFolder('My notes', home);

    expect(folder).toBe(path.join(home, '.pi', '.doom', 'workspace', 'My notes'));
    expect(fs.existsSync(path.join(folder, '.git'))).toBe(true);
    expect(findRepositoryRoot(folder)).toBe(folder);
  });

  it('reuses an existing folder without initializing it again', async () => {
    const home = temporaryHome();
    const folder = await createDefaultWorkspaceFolder('notes', home);
    fs.writeFileSync(path.join(folder, '.git', 'marker'), 'kept');

    await expect(createDefaultWorkspaceFolder('notes', home)).resolves.toBe(folder);
    expect(fs.readFileSync(path.join(folder, '.git', 'marker'), 'utf8')).toBe('kept');
  });

  it('refuses names that are not a single folder', async () => {
    const home = temporaryHome();
    for (const name of ['', '..', '.', 'a/b', '../escape']) {
      await expect(createDefaultWorkspaceFolder(name, home), name).rejects.toThrow('cannot be used');
    }
    expect(fs.existsSync(path.join(home, '.pi', '.doom', 'workspace'))).toBe(false);
  });
});
