import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  doomPiPackageRoot,
  piExtensionAliasIsCurrent,
  piExtensionAliasPath,
  writePiExtensionAlias,
} from '../../src/adapters/piExtensionAlias';
import {
  PI_DISPATCHER_VERSION,
  piExtensionDispatcherIsUpgradeable,
  piExtensionDispatcherVersion,
} from '../../src/adapters/piExtensionDispatcher.ts';
import {
  publishSyncRegistration,
  SYNC_REGISTRATION_VERSION,
  syncStateSha256,
} from '../../src/adapters/syncRegistration.ts';
import { resolveSyncLocation, syncGenerationDirectory } from '../../src/adapters/syncLocation.ts';

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
  vi.unstubAllEnvs();
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

  it('loads the global registration when Pi starts outside a repository', async () => {
    const fixture = temporaryRoot();
    const homeDirectory = path.join(fixture, 'home');
    const globalRoot = path.join(homeDirectory, '.pi', '.doom');
    const currentDirectory = path.join(fixture, 'Documents');
    const agentDirectory = path.join(fixture, 'agent');
    const packageRoot = path.join(fixture, 'install', 'doompi');
    const manifestPath = path.join(packageRoot, 'package.json');
    const entry = path.join(packageRoot, 'extension.mjs');
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.mkdirSync(currentDirectory, { recursive: true });
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        name: '@agimon-ai/doompi',
        version: 'test',
        pi: { extensions: ['./extension.mjs'] },
      })}\n`,
    );
    fs.writeFileSync(entry, 'export default (pi) => pi.loaded();\n');

    const location = resolveSyncLocation(globalRoot, homeDirectory);
    const generation = 'global-test';
    const generationRoot = syncGenerationDirectory(location, generation);
    const statePath = path.join(generationRoot, 'state.json');
    const apiDirectory = path.join(generationRoot, 'api');
    fs.mkdirSync(apiDirectory, { recursive: true });
    fs.writeFileSync(statePath, '{}\n');
    publishSyncRegistration(
      globalRoot,
      {
        version: SYNC_REGISTRATION_VERSION,
        root: location.root,
        identity: location.identity,
        generation,
        generationRoot,
        statePath,
        stateSha256: syncStateSha256(statePath),
        webDirectory: null,
        apiDirectory,
        package: { root: packageRoot, version: 'test', manifestPath, entry },
      },
      homeDirectory,
    );
    const dispatcherPath = writePiExtensionAlias(agentDirectory, packageRoot);
    vi.stubEnv('HOME', homeDirectory);
    const previousDirectory = process.cwd();
    const loaded = vi.fn();
    const on = vi.fn();

    try {
      process.chdir(currentDirectory);
      const dispatcher = (await import(
        `${pathToFileURL(path.join(dispatcherPath, 'dispatcher.mjs')).href}?global`
      )) as {
        default: (pi: { loaded: () => void; on: typeof on }) => Promise<void>;
      };
      await dispatcher.default({ loaded, on });
    } finally {
      process.chdir(previousDirectory);
    }

    expect(loaded).toHaveBeenCalledOnce();
    expect(on).not.toHaveBeenCalled();
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

  it('upgrades an init-owned dispatcher from an earlier protocol', () => {
    const root = temporaryRoot();
    const packageRoot = fakePackage(path.join(root, 'install', 'doompi'));
    const dispatcherPath = piExtensionAliasPath(root);
    fs.mkdirSync(dispatcherPath, { recursive: true });
    fs.writeFileSync(
      path.join(dispatcherPath, 'package.json'),
      `${JSON.stringify({ name: '@agimon-ai/doompi', doompiDispatcher: 1 })}\n`,
    );
    fs.writeFileSync(path.join(dispatcherPath, 'dispatcher.mjs'), 'stale\n');

    writePiExtensionAlias(root, packageRoot);

    const manifest = JSON.parse(fs.readFileSync(path.join(dispatcherPath, 'package.json'), 'utf8')) as {
      doompiDispatcher?: unknown;
    };
    expect(manifest.doompiDispatcher).toBe(PI_DISPATCHER_VERSION);
    expect(piExtensionAliasIsCurrent(root)).toBe(true);
  });

  it('reports a stale managed dispatcher as not current but upgradeable', () => {
    const root = temporaryRoot();
    const dispatcherPath = piExtensionAliasPath(root);
    fs.mkdirSync(dispatcherPath, { recursive: true });
    fs.writeFileSync(
      path.join(dispatcherPath, 'package.json'),
      `${JSON.stringify({ name: '@agimon-ai/doompi', doompiDispatcher: 1 })}\n`,
    );
    fs.writeFileSync(path.join(dispatcherPath, 'dispatcher.mjs'), 'stale\n');

    expect(piExtensionAliasIsCurrent(root)).toBe(false);
    expect(piExtensionDispatcherIsUpgradeable(root)).toBe(true);
    expect(piExtensionDispatcherVersion(root)).toBe(1);
  });

  it('reports a current dispatcher as not upgradeable', () => {
    const root = temporaryRoot();
    const packageRoot = fakePackage(path.join(root, 'install', 'doompi'));
    writePiExtensionAlias(root, packageRoot);

    expect(piExtensionAliasIsCurrent(root)).toBe(true);
    expect(piExtensionDispatcherIsUpgradeable(root)).toBe(false);
    expect(piExtensionDispatcherVersion(root)).toBe(PI_DISPATCHER_VERSION);
  });

  it('reports an unmanaged dispatcher path as not upgradeable', () => {
    const root = temporaryRoot();
    const dispatcherPath = piExtensionAliasPath(root);
    fs.mkdirSync(dispatcherPath, { recursive: true });

    expect(piExtensionDispatcherIsUpgradeable(root)).toBe(false);
    expect(piExtensionDispatcherVersion(root)).toBeUndefined();
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
