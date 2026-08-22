import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { piExtensionAliasPath, writePiExtensionAlias } from '../../src/adapters/piExtensionAlias.ts';
import {
  mergeProjectPiSettings,
  projectPiSettingsPath,
  projectRegistersDoom,
  readProjectPiSettings,
  serializeProjectPiSettings,
  writeProjectPiSettings,
} from '../../src/adapters/projectPiSettings.ts';

const DOOM_PACKAGE_ROOT = path.resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-project-settings-')));
  temporaryRoots.push(root);
  return root;
}

function writeProjectSettings(root: string, settings: Record<string, unknown>): string {
  const settingsPath = projectPiSettingsPath(root);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('mergeProjectPiSettings', () => {
  it('removes the package name from both resource keys', () => {
    const root = temporaryRoot();

    expect(
      mergeProjectPiSettings(
        { extensions: ['@agimon-ai/doompi', './mine.ts'], packages: ['@agimon-ai/doompi', 'pi-skills'] },
        root,
      ),
    ).toEqual({ extensions: ['./mine.ts'], packages: ['pi-skills'] });
  });

  it('removes a relative path that resolves into the installed package', () => {
    const root = temporaryRoot();
    const relative = path.relative(path.join(root, '.pi'), DOOM_PACKAGE_ROOT);

    expect(mergeProjectPiSettings({ extensions: [relative, './mine.ts'] }, root)).toEqual({
      extensions: ['./mine.ts'],
    });
  });

  it('removes a direct reference to a file inside the installed package', () => {
    const root = temporaryRoot();
    const entry = path.join(DOOM_PACKAGE_ROOT, 'package.json');

    expect(mergeProjectPiSettings({ extensions: [entry] }, root)).toEqual({});
  });

  it('removes the object form of a package source', () => {
    const root = temporaryRoot();

    expect(
      mergeProjectPiSettings({ packages: [{ source: '@agimon-ai/doompi', extensions: [] }, 'pi-skills'] }, root),
    ).toEqual({ packages: ['pi-skills'] });
  });

  it('leaves a malformed resource list to Pi to reject', () => {
    const root = temporaryRoot();
    const settings = { extensions: 'not-a-list', packages: [42, null] };

    expect(mergeProjectPiSettings(settings, root)).toEqual(settings);
  });

  it('resolves a home-relative entry against the home directory', () => {
    const root = temporaryRoot();
    const home = path.dirname(DOOM_PACKAGE_ROOT);
    const entry = `~/${path.basename(DOOM_PACKAGE_ROOT)}`;

    expect(mergeProjectPiSettings({ extensions: [entry, './mine.ts'] }, root, home)).toEqual({
      extensions: ['./mine.ts'],
    });
    expect(mergeProjectPiSettings({ extensions: ['~'] }, root, DOOM_PACKAGE_ROOT)).toEqual({});
  });

  it('leaves unrelated keys, unrelated entries, and pattern entries alone', () => {
    const root = temporaryRoot();
    const settings = {
      extensions: ['./mine.ts', '!vendor/*'],
      themes: ['./mine.json'],
      theme: 'doom-pi-dark',
      defaultModel: 'sonnet',
    };

    expect(mergeProjectPiSettings(settings, root)).toEqual(settings);
  });

  it('is idempotent', () => {
    const root = temporaryRoot();
    const once = mergeProjectPiSettings({ extensions: ['@agimon-ai/doompi', './mine.ts'] }, root);

    expect(serializeProjectPiSettings(mergeProjectPiSettings(once, root))).toBe(serializeProjectPiSettings(once));
  });
});

describe('writeProjectPiSettings', () => {
  it('keeps the settings file as a repository root marker when it empties out', () => {
    const root = temporaryRoot();
    const settingsPath = writeProjectSettings(root, { extensions: ['@agimon-ai/doompi'] });

    expect(writeProjectPiSettings(root)).toBe(settingsPath);
    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(readProjectPiSettings(root)).toEqual({});
  });

  it('reports nothing to do when the repository registers no DoomPi', () => {
    const root = temporaryRoot();
    writeProjectSettings(root, { defaultModel: 'sonnet' });

    expect(writeProjectPiSettings(root)).toBeUndefined();
    expect(projectRegistersDoom(root)).toBe(false);
  });

  it('treats a settings file that is not a JSON object as declaring nothing', () => {
    const root = temporaryRoot();
    const settingsPath = projectPiSettingsPath(root);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '["not", "an", "object"]\n');

    expect(readProjectPiSettings(root)).toEqual({});
    expect(projectRegistersDoom(root)).toBe(false);
  });

  it('never creates a settings file the repository does not have', () => {
    const root = temporaryRoot();

    expect(writeProjectPiSettings(root)).toBeUndefined();
    expect(fs.existsSync(projectPiSettingsPath(root))).toBe(false);
  });

  it('removes the project extension alias the registration needed', () => {
    const root = temporaryRoot();
    writeProjectSettings(root, { extensions: ['@agimon-ai/doompi'] });
    const piDirectory = path.join(root, '.pi');
    writePiExtensionAlias(piDirectory);

    writeProjectPiSettings(root);

    expect(fs.existsSync(piExtensionAliasPath(piDirectory))).toBe(false);
  });

  it('refuses to remove an unmanaged path standing in for the alias', () => {
    const root = temporaryRoot();
    writeProjectSettings(root, { extensions: ['@agimon-ai/doompi'] });
    const aliasPath = piExtensionAliasPath(path.join(root, '.pi'));
    fs.mkdirSync(aliasPath, { recursive: true });

    writeProjectPiSettings(root);

    expect(fs.statSync(aliasPath).isDirectory()).toBe(true);
  });
});
