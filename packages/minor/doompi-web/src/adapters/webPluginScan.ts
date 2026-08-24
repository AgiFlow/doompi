import fs from 'node:fs';
import path from 'node:path';
import {
  type DeclaredWebPlugin,
  declaredPluginsOf,
  orderDeclaredPlugins,
  WebPluginManifestError,
} from '../services/webPluginManifest.ts';

/**
 * Reads doompiWeb declarations from explicit package roots.
 *
 * No workspace walking and no hardcoded plugin names: the caller says which
 * packages are in play. At doompi-web's own build time that is just the host
 * package (its built-in plugins); at `doompi sync` time it is the installed
 * composition's package roots.
 */
export function scanWebPlugins(hostDir: string, pluginRoots: readonly string[] = []): DeclaredWebPlugin[] {
  const seen = new Set<string>();
  const plugins: DeclaredWebPlugin[] = [];
  const hostResolved = path.resolve(hostDir);
  for (const root of [hostDir, ...pluginRoots]) {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8')) as Record<string, unknown>;
    } catch (error) {
      throw new WebPluginManifestError(resolved, `package.json is unreadable: ${String(error)}`);
    }
    const declared = declaredPluginsOf(resolved, manifest, resolved === hostResolved);
    for (const plugin of declared) {
      const entryPath = path.join(resolved, plugin.client.entry);
      if (!fs.existsSync(entryPath)) {
        throw new WebPluginManifestError(resolved, `client.entry '${plugin.client.entry}' does not exist.`);
      }
      if (plugin.hub && !fs.existsSync(path.join(resolved, plugin.hub.entry))) {
        throw new WebPluginManifestError(resolved, `hub.entry '${plugin.hub.entry}' does not exist.`);
      }
    }
    plugins.push(...declared);
  }
  return orderDeclaredPlugins(plugins);
}
