import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readSyncRegistration: vi.fn() }));

vi.mock('@agimon-ai/doompi-core/syncRegistration', () => ({ readSyncRegistration: mocks.readSyncRegistration }));

import {
  WEB_PLUGIN_RUNTIME_SPECIFIERS,
  readDevPluginRoots,
  webPluginOverridePlugin,
  webPluginRuntimeAliases,
  webPluginRuntimeGlobal,
} from '@agimon-ai/doompi/webBuilder';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-vite-')));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('the standalone plugin runtime facade', () => {
  it('externalizes the complete shared singleton set by exact specifier', () => {
    expect(WEB_PLUGIN_RUNTIME_SPECIFIERS).toEqual([
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      '@tanstack/store',
      '@tanstack/react-store',
      '@agimon-ai/doompi-core/web',
      '@agimon-ai/doompi-web-components',
      '@agimon-ai/doompi-web-security/browser',
      '@codemirror/state',
      '@codemirror/view',
    ]);
    expect(webPluginRuntimeGlobal('react/jsx-runtime')).toBe('globalThis.DoomPiWebPluginRuntime.reactJsxRuntime');
    expect(webPluginRuntimeGlobal('react/jsx-dev-runtime')).toBe(
      'globalThis.DoomPiWebPluginRuntime.reactJsxDevRuntime',
    );
    expect(webPluginRuntimeGlobal('@codemirror/view')).toBe('globalThis.DoomPiWebPluginRuntime.codemirrorView');
  });

  it('resolves transformed plugin imports from the host runtime dependency tree', () => {
    const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/web');
    const alias = webPluginRuntimeAliases(clientRoot).find(
      ({ find }) => find instanceof RegExp && find.test('react/jsx-dev-runtime'),
    );

    if (alias === undefined || !(alias.find instanceof RegExp)) {
      throw new Error('The host runtime did not resolve the React JSX development runtime.');
    }
    expect(alias.find.test('react/jsx-dev-runtime/extra')).toBe(false);
    expect(fs.existsSync(alias.replacement)).toBe(true);
  });
  it('only delegates resolution for generated registry imports', async () => {
    const root = '/host/web';
    const generated = {
      clientModulePath: '/generated/client.ts',
      cssModulePath: '/generated/styles.css',
      compositionModulePath: '/generated/composition.ts',
    };
    const hook = webPluginOverridePlugin(root, generated).resolveId;
    if (typeof hook !== 'function') throw new Error('Expected a resolveId hook.');
    const resolve = vi.fn(async (source: string) => ({
      id:
        source === './webPlugins.generated'
          ? path.join(root, 'app/webPlugins.generated.ts')
          : source === './webPluginSources.generated.css'
            ? path.join(root, 'styles/webPluginSources.generated.css')
            : source,
    }));
    const context = { resolve } as never;
    for (const source of ['react', './unrelated.ts', '\0virtual-module']) {
      expect(await hook.call(context, source, undefined, { isEntry: false })).toBeNull();
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(await hook.call(context, './webPlugins.generated', undefined, { isEntry: false })).toBe(
      generated.clientModulePath,
    );
    expect(await hook.call(context, './webPluginSources.generated.css', undefined, { isEntry: false })).toBe(
      generated.cssModulePath,
    );
    expect(await hook.call(context, '/elsewhere/webPlugins.generated.ts', undefined, { isEntry: false })).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(3);
  });
});
describe('readDevPluginRoots', () => {
  it('prefers an explicit roots list without reading a registration', () => {
    expect(readDevPluginRoots({ DOOMPI_WEB_PLUGIN_ROOTS: ['/one', '/two'].join(path.delimiter) }, '/home')).toEqual([
      '/one',
      '/two',
    ]);
    expect(mocks.readSyncRegistration).not.toHaveBeenCalled();
  });

  it('returns no roots when no repository is selected', () => {
    expect(readDevPluginRoots({}, '/home')).toEqual([]);
  });

  it('reads roots beside the selected repository web bundle', () => {
    const generation = temporaryDirectory();
    const webDirectory = path.join(generation, 'web');
    fs.mkdirSync(webDirectory);
    fs.writeFileSync(path.join(generation, 'pluginRoots.json'), '["/synced-a", "/synced-b"]\n');
    mocks.readSyncRegistration.mockReturnValue({ webDirectory });

    expect(readDevPluginRoots({ DOOMPI_ROOT: '/repo' }, '/home')).toEqual(['/synced-a', '/synced-b']);
    expect(mocks.readSyncRegistration).toHaveBeenCalledWith('/repo', '/home');
  });

  it('fails closed for absent or invalid registrations', () => {
    mocks.readSyncRegistration.mockReturnValueOnce({ webDirectory: null });
    expect(readDevPluginRoots({ DOOMPI_ROOT: '/repo' }, '/home')).toEqual([]);

    mocks.readSyncRegistration.mockImplementationOnce(() => {
      throw new Error('invalid registration');
    });
    expect(readDevPluginRoots({ DOOMPI_ROOT: '/repo' }, '/home')).toEqual([]);
  });
});
