import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readSyncRegistration } from '@agimon-ai/doompi/services';
import type { Alias, Plugin } from 'vite';
import { devPluginRoots, PLUGIN_ROOTS_ENV, PLUGIN_ROOTS_FILE } from '../services/webDevRoots.ts';
import type { SyncGeneratedModules } from './webPluginGenerate.ts';

const DOOMPI_ROOT_ENV = 'DOOMPI_ROOT';

export const WEB_PLUGIN_RUNTIME_SPECIFIERS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  '@tanstack/store',
  '@tanstack/react-store',
  '@agimon-ai/doompi-web-contracts',
  '@agimon-ai/doompi-web-components',
  '@agimon-ai/doompi-web-security/browser',
  '@codemirror/state',
  '@codemirror/view',
] as const;

const WEB_PLUGIN_RUNTIME_PROPERTIES: Record<(typeof WEB_PLUGIN_RUNTIME_SPECIFIERS)[number], string> = {
  react: 'react',
  'react/jsx-runtime': 'reactJsxRuntime',
  'react/jsx-dev-runtime': 'reactJsxDevRuntime',
  'react-dom': 'reactDom',
  'react-dom/client': 'reactDomClient',
  '@tanstack/store': 'tanstackStore',
  '@tanstack/react-store': 'tanstackReactStore',
  '@agimon-ai/doompi-web-contracts': 'webContracts',
  '@agimon-ai/doompi-web-components': 'webComponents',
  '@agimon-ai/doompi-web-security/browser': 'webSecurityBrowser',
  '@codemirror/state': 'codemirrorState',
  '@codemirror/view': 'codemirrorView',
};

/** Rollup expression for a shared module supplied by the session shell. */
export function webPluginRuntimeGlobal(specifier: (typeof WEB_PLUGIN_RUNTIME_SPECIFIERS)[number]): string {
  return `globalThis.DoomPiWebPluginRuntime.${WEB_PLUGIN_RUNTIME_PROPERTIES[specifier]}`;
}

/** Resolves generated JSX imports from the host instead of a plugin's optional React peer tree. */
export function webPluginRuntimeAliases(clientRoot: string): Alias[] {
  const runtimeRequire = createRequire(path.join(clientRoot, 'index.html'));
  return WEB_PLUGIN_RUNTIME_SPECIFIERS.filter((specifier) => specifier.startsWith('react/jsx-')).map((specifier) => ({
    find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'u'),
    replacement: runtimeRequire.resolve(specifier),
  }));
}

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

/** The plugin package roots the dev server should serve, from an explicit override or DOOMPI_ROOT. */
export function readDevPluginRoots(environment: NodeJS.ProcessEnv, homeDirectory: string): string[] {
  const explicit = environment[PLUGIN_ROOTS_ENV];
  if (explicit !== undefined && explicit !== '') {
    return devPluginRoots({ envValue: explicit, rootsFileText: undefined, delimiter: path.delimiter });
  }
  const repoRoot = environment[DOOMPI_ROOT_ENV];
  if (repoRoot === undefined || repoRoot === '') return [];
  try {
    const webDirectory = readSyncRegistration(repoRoot, homeDirectory)?.webDirectory;
    const rootsFile =
      webDirectory === null || webDirectory === undefined
        ? undefined
        : path.join(path.dirname(webDirectory), PLUGIN_ROOTS_FILE);
    return devPluginRoots({
      envValue: undefined,
      rootsFileText:
        rootsFile !== undefined && fs.existsSync(rootsFile) ? fs.readFileSync(rootsFile, 'utf8') : undefined,
      delimiter: path.delimiter,
    });
  } catch {
    return [];
  }
}
