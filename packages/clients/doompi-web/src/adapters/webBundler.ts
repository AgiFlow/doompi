import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOTS_FILE } from '../services/webDevRoots.ts';
import { SERVER_REGISTRY_FILE, webHostPackageRoot, writeSyncWebPluginModules } from './webPluginGenerate.ts';
import { scanWebPlugins } from './webPluginScan.ts';
import {
  WEB_PLUGIN_RUNTIME_SPECIFIERS,
  webPluginCssAlias,
  webPluginOverridePlugin,
  webPluginRuntimeAliases,
  webPluginRuntimeGlobal,
} from './webPluginVite.ts';

/** Shared runtime packages every plugin's client code must resolve to the host copies. */
const DEDUPED_RUNTIMES = [
  'react',
  'react-dom',
  '@tanstack/store',
  '@tanstack/react-store',
  '@agimon-ai/doompi-web-components',
  // The sealed transport is a module singleton whose nonce counters every
  // plugin shares; a second copy would start counting at zero.
  '@agimon-ai/doompi-web-security',
  // CodeMirror's state and view are singletons in all but name: a document
  // built against one copy is rejected by an editor from the other, and a
  // grammar chunk resolved separately from the editor is exactly how a second
  // copy appears.
  '@codemirror/state',
  '@codemirror/view',
];

export interface BundleCockpitWebOptions {
  /** Package roots to scan for doompiWeb manifests, usually the installed composition. */
  pluginRoots: readonly string[];
  /** Output directory; receives web/, plugins/, generated/, and pluginRoots.json. */
  outDir: string;
  onNotice?: (message: string) => void;
}

export interface BundleCockpitWebResult {
  /** Full synchronized SPA retained for CLI compatibility. */
  assetsDir: string;
  /** Standalone session plugin composition artifacts. */
  pluginsDir: string;
  pluginIds: string[];
}

/**
 * Builds the cockpit SPA against the installed plugin set.
 *
 * This is what `doompi sync` calls: manifests come from the given package
 * roots (no hardcoded plugin dependencies anywhere), the generated entry
 * modules are aliased over the committed builtin registry, and Vite compiles
 * everything (host shell plus each plugin's shipped web source) into one
 * bundle. The server registry written next to the assets tells the hub which
 * built hub entries to load, and the roots file beside the bundle lets the
 * dev server serve the same composition with hot reload.
 */
export async function bundleCockpitWeb(options: BundleCockpitWebOptions): Promise<BundleCockpitWebResult> {
  const notice = options.onNotice ?? ((): void => {});
  const hostRoot = webHostPackageRoot();
  const plugins = scanWebPlugins(hostRoot, options.pluginRoots, notice);
  notice(
    `bundling the cockpit with ${String(plugins.length)} web plugin(s): ${plugins.map((p) => p.pluginId).join(', ')}`,
  );

  const generatedDir = path.join(options.outDir, 'generated');
  const assetsDir = path.join(options.outDir, 'web');
  const pluginsDir = path.join(options.outDir, 'plugins');
  const generated = writeSyncWebPluginModules(plugins, generatedDir);
  const roots = [...new Set(options.pluginRoots.map((root) => path.resolve(root)))];
  fs.writeFileSync(path.join(options.outDir, PLUGIN_ROOTS_FILE), `${JSON.stringify(roots, null, 2)}\n`);

  // Vite and its plugins are regular dependencies so this works from an
  // installed package, not only the workspace.
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const { default: tailwindcss } = await import('@tailwindcss/vite');

  const clientRoot = path.join(hostRoot, 'src', 'web');

  await build({
    configFile: false,
    envDir: false,
    logLevel: 'warn',
    root: clientRoot,
    plugins: [webPluginOverridePlugin(clientRoot, generated), react(), tailwindcss()],
    resolve: {
      dedupe: [...DEDUPED_RUNTIMES],
      alias: [...webPluginRuntimeAliases(clientRoot), webPluginCssAlias(generated)],
    },
    build: {
      outDir: assetsDir,
      emptyOutDir: true,
      sourcemap: false,
    },
  });

  await build({
    configFile: false,
    envDir: false,
    logLevel: 'warn',
    base: './',
    plugins: [react(), tailwindcss()],
    resolve: {
      dedupe: [...DEDUPED_RUNTIMES],
      alias: [webPluginCssAlias(generated)],
    },
    build: {
      cssCodeSplit: false,
      outDir: pluginsDir,
      emptyOutDir: true,
      sourcemap: false,
      assetsInlineLimit: 0,
      manifest: 'manifest.json',
      rollupOptions: {
        input: generated.compositionModulePath,
        external: [...WEB_PLUGIN_RUNTIME_SPECIFIERS],
        output: {
          format: 'iife',
          name: 'DoomPiWebPluginCompositionBundle',
          entryFileNames: 'composition.js',
          globals: Object.fromEntries(
            WEB_PLUGIN_RUNTIME_SPECIFIERS.map((specifier) => [specifier, webPluginRuntimeGlobal(specifier)]),
          ),
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });
  fs.writeFileSync(path.join(pluginsDir, 'index.html'), '<!doctype html>\n<title>DoomPi plugin composition</title>\n');

  fs.writeFileSync(path.join(options.outDir, SERVER_REGISTRY_FILE), generated.serverRegistry);
  return { assetsDir, pluginsDir, pluginIds: plugins.map((plugin) => plugin.pluginId) };
}
