import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginBlocksOf } from '../../src/services/webPluginManifest.ts';

/**
 * Every workspace package that declares a cockpit plugin, found by walking.
 *
 * Both the contract test and the browser suite need this list, and the browser
 * suite used to carry its own hardcoded copy of fourteen paths. It had drifted:
 * the domain, profile, help, and loop plugins ship in the bundle `doompi sync`
 * produces and were absent from the suite that is supposed to prove it. A walk
 * cannot drift, so a plugin added tomorrow is covered without anyone
 * remembering to add it here.
 */

export const HOST_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = path.resolve(HOST_ROOT, '..', '..', '..');
/** Where the distribution keeps packages; a plugin may live in either tree. */
const PACKAGE_GROUPS = ['packages', 'layers'];

export interface PluginPackage {
  root: string;
  /** How many doompiWeb blocks it declares; a package may ship more than one. */
  blocks: number;
}

export function pluginPackageRoots(): PluginPackage[] {
  const found: PluginPackage[] = [];
  for (const group of PACKAGE_GROUPS) {
    const groupDir = path.join(REPO_ROOT, group);
    for (const tier of fs.readdirSync(groupDir)) {
      const tierDir = path.join(groupDir, tier);
      if (!fs.statSync(tierDir).isDirectory()) continue;
      for (const name of fs.readdirSync(tierDir)) {
        const root = path.join(tierDir, name);
        const manifestPath = path.join(root, 'package.json');
        // The host is not one of its own plugins, and a directory without a
        // manifest is a build artefact rather than a package.
        if (root === path.resolve(HOST_ROOT) || !fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        const blocks = pluginBlocksOf(manifest).length;
        if (blocks > 0) found.push({ root, blocks });
      }
    }
  }
  return found.sort((left, right) => left.root.localeCompare(right.root));
}
