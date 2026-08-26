import fs from 'node:fs';
import path from 'node:path';
import type { Alias, Plugin } from 'vite';
import { devPluginRoots, PLUGIN_ROOTS_ENV, PLUGIN_ROOTS_FILE } from '../services/webDevRoots.ts';
import type { SyncGeneratedModules } from './webPluginGenerate.ts';

/** Where `doompi sync` publishes the bundle the server prefers; the roots file sits beside its assets. */
const SYNCED_BUNDLE_DIRECTORY = ['.doompi', 'web', 'current'];

/**
 * Swaps the committed builtin registry modules for generated ones. A
 * resolveId hook rather than resolve.alias because aliases match raw import
 * specifiers while these two are known by their resolved paths. Both the
 * sync-time build and the dev server use it, so a plugin edit in dev is the
 * same module the bundle would carry.
 */
export function webPluginOverridePlugin(clientRoot: string, generated: SyncGeneratedModules): Plugin {
  const overrides = new Map([
    [path.join(clientRoot, 'app', 'webPlugins.generated.ts'), generated.clientModulePath],
    [path.join(clientRoot, 'styles', 'webPluginSources.generated.css'), generated.cssModulePath],
  ]);
  return {
    name: 'doompi-web-plugin-overrides',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      return overrides.get(resolved.id) ?? null;
    },
  };
}

/**
 * The CSS sources module cannot ride the resolveId hook: Vite and Tailwind
 * resolve CSS @import through Vite's own id resolver, which consults aliases
 * but no plugin hooks. Without this the builtin (empty) @source list ships
 * and every plugin-only utility class is missing.
 */
export function webPluginCssAlias(generated: SyncGeneratedModules): Alias {
  return { find: /^\.\/webPluginSources\.generated\.css$/, replacement: generated.cssModulePath };
}

/** The plugin package roots the dev server should serve, from the environment or the last sync. */
export function readDevPluginRoots(environment: NodeJS.ProcessEnv, homeDirectory: string): string[] {
  const rootsFile = path.join(homeDirectory, ...SYNCED_BUNDLE_DIRECTORY, PLUGIN_ROOTS_FILE);
  return devPluginRoots({
    envValue: environment[PLUGIN_ROOTS_ENV],
    rootsFileText: fs.existsSync(rootsFile) ? fs.readFileSync(rootsFile, 'utf8') : undefined,
    delimiter: path.delimiter,
  });
}
