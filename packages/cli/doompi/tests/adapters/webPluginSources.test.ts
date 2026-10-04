import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { writeSyncWebPluginModules } from '../../src/builders/web/webPluginGenerate';
import { scanWebPlugins } from '../../src/builders/web/webPluginScan';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePackage(dir: string, manifest: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
}

/** doompi-web as a package manager installs it: its dependencies beside it, not inside it. */
function installedWeb(): { webRoot: string; templateExtensions: string } {
  const modules = path.join(tempDir('doompi-installed-'), 'node_modules', '@agimon-ai');
  const webRoot = path.join(modules, 'doompi-web');
  writePackage(webRoot, { name: '@agimon-ai/doompi-web' });
  const templateRoot = path.join(modules, 'doompi-template-advanced');
  const templateExtensions = path.join(templateRoot, 'dist', 'extensions');
  writePackage(templateRoot, {
    name: '@agimon-ai/doompi-template-advanced',
    exports: { './package.json': './package.json' },
  });
  fs.mkdirSync(templateExtensions, { recursive: true });
  fs.writeFileSync(path.join(templateExtensions, 'web.mjs'), '');
  return { webRoot, templateExtensions };
}

describe('the sync web plugin sources', () => {
  it('scans the fallback template where an installed doompi-web resolves it', () => {
    const { webRoot, templateExtensions } = installedWeb();

    const { cssModulePath } = writeSyncWebPluginModules([], tempDir('doompi-generated-'), webRoot);

    // app.css's relative path points into doompi-web/node_modules, which an install does not have.
    expect(fs.readFileSync(cssModulePath, 'utf8').split('\n')).toEqual(
      expect.arrayContaining([`@source "${path.join(webRoot, 'src', 'web')}";`, `@source "${templateExtensions}";`]),
    );
  });

  it('resolves generated plugin imports through installed package symlinks', () => {
    const { webRoot } = installedWeb();
    const packageRoot = tempDir('doompi-plugin-package-');
    const packageEntry = path.join(packageRoot, 'dist/extensions/web.mjs');
    writePackage(packageRoot, {
      name: '@agimon-ai/doompi-example',
      doompiWeb: {
        pluginId: 'example',
        client: { entry: './dist/extensions/web.mjs' },
        scopes: ['session'],
      },
    });
    fs.mkdirSync(path.dirname(packageEntry), { recursive: true });
    fs.writeFileSync(packageEntry, 'export const webPlugin = {};\n');

    const installRoot = tempDir('doompi-plugin-install-');
    const packageScope = path.join(installRoot, 'node_modules', '@agimon-ai');
    fs.mkdirSync(packageScope, { recursive: true });
    const installedRoot = path.join(packageScope, 'doompi-example');
    fs.symlinkSync(packageRoot, installedRoot, 'dir');

    const plugins = scanWebPlugins(webRoot, [installedRoot]);
    const { clientModulePath } = writeSyncWebPluginModules(plugins, tempDir('doompi-generated-'), webRoot);
    const generated = fs.readFileSync(clientModulePath, 'utf8');
    expect(generated).toContain(
      pathToFileURL(fs.realpathSync(path.join(installedRoot, 'dist/extensions/web.mjs'))).href,
    );
  });
});
