import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  doomPiPackageRoot,
  piExtensionAliasIsCurrent,
  piExtensionAliasPath,
  writePiExtensionAlias,
} from '../../src/adapters/piExtensionAlias';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-extension-alias-')));
  temporaryRoots.push(root);
  return root;
}

function fakePackage(root: string, name = '@agimon-ai/doompi'): string {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name })}\n`);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Pi extension package alias', () => {
  it('locates the package root from the executing module', () => {
    expect(doomPiPackageRoot()).toBe(path.resolve(import.meta.dirname, '../..'));
  });

  it('creates a relative directory link at the path Pi derives from settings', () => {
    const root = temporaryRoot();
    const packageRoot = fakePackage(path.join(root, 'install', 'doompi'));
    const aliasPath = writePiExtensionAlias(root, packageRoot);

    expect(aliasPath).toBe(piExtensionAliasPath(root));
    expect(fs.lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(path.isAbsolute(fs.readlinkSync(aliasPath))).toBe(false);
    expect(fs.realpathSync(aliasPath)).toBe(fs.realpathSync(packageRoot));
    expect(piExtensionAliasIsCurrent(root, packageRoot)).toBe(true);
  });

  it('lets Pi resolve the stable value from user settings through the package manifest', async () => {
    const root = temporaryRoot();
    const agentDirectory = path.join(root, 'agent');
    const packageRoot = fakePackage(path.join(root, 'install', 'doompi'));
    const extension = path.join(packageRoot, 'dist', 'index.mjs');
    fs.mkdirSync(path.dirname(extension), { recursive: true });
    fs.mkdirSync(agentDirectory, { recursive: true });
    fs.writeFileSync(extension, 'export default () => undefined;\n');
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({ name: '@agimon-ai/doompi', pi: { extensions: ['./dist/index.mjs'] } })}\n`,
    );
    writePiExtensionAlias(agentDirectory, packageRoot);
    fs.writeFileSync(path.join(agentDirectory, 'settings.json'), '{"extensions":["@agimon-ai/doompi"]}\n');
    const settingsManager = SettingsManager.create(root, agentDirectory, { projectTrusted: true });
    const packageManager = new DefaultPackageManager({ cwd: root, agentDir: agentDirectory, settingsManager });

    const resolved = await packageManager.resolve();

    expect(resolved.extensions).toEqual([
      expect.objectContaining({
        path: path.join(piExtensionAliasPath(agentDirectory), 'dist', 'index.mjs'),
        enabled: true,
      }),
    ]);
  });

  it('repairs a stale or broken managed link', () => {
    const root = temporaryRoot();
    const packageRoot = fakePackage(path.join(root, 'install', 'doompi'));
    const aliasPath = piExtensionAliasPath(root);
    fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
    fs.symlinkSync('../missing-doompi', aliasPath, 'dir');

    writePiExtensionAlias(root, packageRoot);

    expect(fs.realpathSync(aliasPath)).toBe(fs.realpathSync(packageRoot));
  });

  it('does not replace an unmanaged path', () => {
    const root = temporaryRoot();
    const packageRoot = fakePackage(path.join(root, 'install', 'doompi'));
    const aliasPath = piExtensionAliasPath(root);
    fs.mkdirSync(aliasPath, { recursive: true });

    expect(() => writePiExtensionAlias(root, packageRoot)).toThrow('Refusing to replace unmanaged Pi extension path');
    expect(fs.statSync(aliasPath).isDirectory()).toBe(true);
  });

  it('rejects a target that is not the DoomPi package', () => {
    const root = temporaryRoot();
    const packageRoot = fakePackage(path.join(root, 'install', 'other'), '@example/other');

    expect(() => writePiExtensionAlias(root, packageRoot)).toThrow('Cannot alias @agimon-ai/doompi');
  });
});
