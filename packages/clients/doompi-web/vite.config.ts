import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Alias, defineConfig, type Plugin } from 'vite';
import { ensureBuiltinWebPluginModules, writeSyncWebPluginModules } from './src/adapters/webPluginGenerate.ts';
import { scanWebPlugins } from './src/adapters/webPluginScan.ts';
import { readDevPluginRoots, webPluginCssAlias, webPluginOverridePlugin } from './src/adapters/webPluginVite.ts';

// Config-load time keeps the committed builtin registry fresh for both build
// and dev without touching the pinned build script; CI only checks. The full
// installed plugin set is bundled later, by doompi sync, not here.
ensureBuiltinWebPluginModules({ check: Boolean(process.env.CI) });

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const clientRoot = fileURLToPath(new URL('./src/web', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/web', import.meta.url));

/**
 * The plugin dev loop. `vite` (not `vite build`) serves the installed
 * composition's plugins from their source, generated into .dev/ and aliased
 * over the committed empty registry exactly as `doompi sync` does, so a
 * plugin edit hot-reloads against the hub the /api proxy points at. The roots
 * come from DOOMPI_WEB_PLUGIN_ROOTS or the last sync; with neither, dev
 * serves the shell alone, as before.
 */
function devPluginOverrides(command: 'build' | 'serve'): { plugins: Plugin[]; alias: Alias[] } {
  if (command !== 'serve') return { plugins: [], alias: [] };
  const roots = readDevPluginRoots(process.env, os.homedir());
  if (roots.length === 0) return { plugins: [], alias: [] };
  const notice = (message: string): void => {
    console.warn(`[doompi-web] ${message}`);
  };
  const plugins = scanWebPlugins(packageRoot, roots, notice);
  notice(`dev serving ${String(plugins.length)} web plugin(s): ${plugins.map((plugin) => plugin.pluginId).join(', ')}`);
  const generated = writeSyncWebPluginModules(plugins, path.join(packageRoot, '.dev', 'generated'));
  return { plugins: [webPluginOverridePlugin(clientRoot, generated)], alias: [webPluginCssAlias(generated)] };
}

export default defineConfig(({ command }) => {
  const dev = devPluginOverrides(command);
  return {
    root: clientRoot,
    plugins: [...dev.plugins, react(), tailwindcss()],
    resolve: {
      // One instance of each shared runtime even when a plugin package declares
      // its own copies for typechecking.
      dedupe: [
        'react',
        'react-dom',
        '@tanstack/store',
        '@tanstack/react-store',
        '@agimon-ai/doompi-web-components',
        // The sealed transport is a module singleton whose nonce counters every
        // plugin shares; a second copy would start counting at zero.
        '@agimon-ai/doompi-web-security/browser',
        // CodeMirror's state and view are singletons in all but name: a
        // document built against one copy is rejected by an editor from the
        // other.
        '@codemirror/state',
        '@codemirror/view',
      ],
      alias: dev.alias,
    },
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
    },
    server: {
      port: 7434,
      proxy: {
        '/api': { target: 'http://127.0.0.1:7433', ws: true },
      },
    },
  };
});
