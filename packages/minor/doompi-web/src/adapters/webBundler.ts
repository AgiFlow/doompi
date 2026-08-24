import fs from 'node:fs';
import path from 'node:path';
import { SERVER_REGISTRY_FILE, webHostPackageRoot, writeSyncWebPluginModules } from './webPluginGenerate.ts';
import { scanWebPlugins } from './webPluginScan.ts';

/** Shared runtime packages every plugin's client code must resolve to the host copies. */
const DEDUPED_RUNTIMES = ['react', 'react-dom', '@tanstack/store', '@tanstack/react-store'];

export interface BundleCockpitWebOptions {
  /** Package roots to scan for doompiWeb manifests, usually the installed composition. */
  pluginRoots: readonly string[];
  /** Output directory; receives web/ (the bundle) and generated/ (the entry modules). */
  outDir: string;
  onNotice?: (message: string) => void;
}

export interface BundleCockpitWebResult {
  /** The assets directory to serve (contains index.html and the server registry). */
  assetsDir: string;
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
 * built hub entries to load.
 */
export async function bundleCockpitWeb(options: BundleCockpitWebOptions): Promise<BundleCockpitWebResult> {
  const notice = options.onNotice ?? ((): void => {});
  const hostRoot = webHostPackageRoot();
  const plugins = scanWebPlugins(hostRoot, options.pluginRoots);
  notice(
    `bundling the cockpit with ${String(plugins.length)} web plugin(s): ${plugins.map((p) => p.pluginId).join(', ')}`,
  );

  const generatedDir = path.join(options.outDir, 'generated');
  const assetsDir = path.join(options.outDir, 'web');
  const generated = writeSyncWebPluginModules(plugins, generatedDir);

  // Vite and its plugins are regular dependencies so this works from an
  // installed package, not only the workspace.
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const { default: tailwindcss } = await import('@tailwindcss/vite');

  const clientRoot = path.join(hostRoot, 'src', 'web');
  const overrides = new Map([
    [path.join(clientRoot, 'app', 'webPlugins.generated.ts'), generated.clientModulePath],
    [path.join(clientRoot, 'styles', 'webPluginSources.generated.css'), generated.cssModulePath],
  ]);

  await build({
    configFile: false,
    envDir: false,
    logLevel: 'warn',
    root: clientRoot,
    plugins: [
      {
        // Swaps the committed builtin registry modules for the sync-generated
        // ones. A resolveId hook rather than resolve.alias because aliases
        // match raw import specifiers while these two are known by their
        // resolved paths.
        name: 'doompi-web-plugin-overrides',
        enforce: 'pre',
        async resolveId(source, importer, options) {
          const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
          if (!resolved) return null;
          return overrides.get(resolved.id) ?? null;
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: {
      dedupe: [...DEDUPED_RUNTIMES],
      // The CSS sources module cannot ride the resolveId hook above: Vite and
      // Tailwind resolve CSS @import through Vite's own id resolver, which
      // consults aliases but no plugin hooks. Without this the builtin (empty)
      // @source list ships and every plugin-only utility class is missing.
      alias: [{ find: /^\.\/webPluginSources\.generated\.css$/, replacement: generated.cssModulePath }],
    },
    build: {
      outDir: assetsDir,
      emptyOutDir: true,
      sourcemap: false,
    },
  });

  fs.writeFileSync(path.join(assetsDir, SERVER_REGISTRY_FILE), generated.serverRegistry);
  return { assetsDir, pluginIds: plugins.map((plugin) => plugin.pluginId) };
}
