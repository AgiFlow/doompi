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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-extension-dispatcher-')));
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

describe('Pi extension dispatcher package', () => {
  it('locates the package root from the executing module', () => {
    expect(doomPiPackageRoot()).toBe(path.resolve(import.meta.dirname, '../..'));
  });

  it('creates an init-owned dependency-free package at the stable Pi path', () => {
    const root = temporaryRoot();
    const packageRoot = fakePackage(path.join(root, 'install', 'doompi'));
    const dispatcherPath = writePiExtensionAlias(root, packageRoot);
    const manifest = JSON.parse(fs.readFileSync(path.join(dispatcherPath, 'package.json'), 'utf8')) as {
      private?: unknown;
      type?: unknown;
      pi?: { extensions?: unknown };
      dependencies?: unknown;
    };

    expect(dispatcherPath).toBe(piExtensionAliasPath(root));
    expect(fs.lstatSync(dispatcherPath).isDirectory()).toBe(true);
    expect(fs.lstatSync(dispatcherPath).isSymbolicLink()).toBe(false);
    expect(manifest).toMatchObject({
      private: true,
      type: 'module',
      pi: { extensions: ['./dispatcher.mjs'] },
    });
    expect(manifest.dependencies).toBeUndefined();
    expect(piExtensionAliasIsCurrent(root, packageRoot)).toBe(true);
  });

  it('lets Pi resolve the stable setting through the dispatcher manifest', async () => {
    const root = temporaryRoot();
    const agentDirectory = path.join(root, 'agent');
    const packageRoot = fakePackage(path.join(root, 'install', 'doompi'));
    fs.mkdirSync(agentDirectory, { recursive: true });
    writePiExtensionAlias(agentDirectory, packageRoot);
    fs.writeFileSync(path.join(agentDirectory, 'settings.json'), '{"extensions":["@agimon-ai/doompi"]}\n');
    const settingsManager = SettingsManager.create(root, agentDirectory, { projectTrusted: true });
    const packageManager = new DefaultPackageManager({ cwd: root, agentDir: agentDirectory, settingsManager });

    const resolved = await packageManager.resolve();

    expect(resolved.extensions).toEqual([
      expect.objectContaining({
        path: path.join(piExtensionAliasPath(agentDirectory), 'dispatcher.mjs'),
        enabled: true,
      }),
    ]);
  });

  it('migrates a legacy DoomPi package link', () => {
    const root = temporaryRoot();
    const packageRoot = fakePackage(path.join(root, 'install', 'doompi'));
    const dispatcherPath = piExtensionAliasPath(root);
    fs.mkdirSync(path.dirname(dispatcherPath), { recursive: true });
    fs.symlinkSync(packageRoot, dispatcherPath, 'dir');

    writePiExtensionAlias(root, packageRoot);

    expect(fs.lstatSync(dispatcherPath).isDirectory()).toBe(true);
    expect(fs.lstatSync(dispatcherPath).isSymbolicLink()).toBe(false);
    expect(piExtensionAliasIsCurrent(root)).toBe(true);
  });

  it('does not replace an unmanaged path', () => {
    const root = temporaryRoot();
    const packageRoot = fakePackage(path.join(root, 'install', 'doompi'));
    const dispatcherPath = piExtensionAliasPath(root);
    fs.mkdirSync(dispatcherPath, { recursive: true });

    expect(() => writePiExtensionAlias(root, packageRoot)).toThrow('Refusing to replace unmanaged Pi extension path');
    expect(fs.statSync(dispatcherPath).isDirectory()).toBe(true);
  });

  it('rejects an initializer that is not the DoomPi package', () => {
    const root = temporaryRoot();
    const packageRoot = fakePackage(path.join(root, 'install', 'other'), '@example/other');

    expect(() => writePiExtensionAlias(root, packageRoot)).toThrow('Cannot initialize @agimon-ai/doompi');
  });
});
