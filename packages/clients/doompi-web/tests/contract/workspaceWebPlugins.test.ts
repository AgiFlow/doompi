import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WebPluginDefinition } from '@agimon-ai/doompi-web-contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { scanWebPlugins } from '../../src/adapters/webPluginScan.ts';
import { pluginBlocksOf } from '../../src/services/webPluginManifest.ts';
import { PACKAGED_MINOR_MODES, PACKAGED_SELECTION_AXES } from '../../src/web/lib/composition.ts';
import {
  installWebPlugins,
  pluginMinorModes,
  pluginSelectionAxes,
  resetWebPlugins,
  webPluginDiagnostics,
} from '../../src/web/lib/pluginRegistry.ts';

const hostRoot = fileURLToPath(new URL('../..', import.meta.url));
const repoRoot = path.resolve(hostRoot, '..', '..', '..');
const PACKAGE_GROUPS = ['packages', 'layers'];

/** Every workspace package with a doompiWeb block, found by walking, never by name. */
function pluginPackageRoots(): { root: string; blocks: number }[] {
  const found: { root: string; blocks: number }[] = [];
  for (const group of PACKAGE_GROUPS) {
    const groupDir = path.join(repoRoot, group);
    for (const tier of fs.readdirSync(groupDir)) {
      const tierDir = path.join(groupDir, tier);
      if (!fs.statSync(tierDir).isDirectory()) continue;
      for (const name of fs.readdirSync(tierDir)) {
        const root = path.join(tierDir, name);
        const manifestPath = path.join(root, 'package.json');
        if (root === path.resolve(hostRoot) || !fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        const blocks = pluginBlocksOf(manifest).length;
        if (blocks > 0) found.push({ root, blocks });
      }
    }
  }
  return found.sort((left, right) => left.root.localeCompare(right.root));
}

afterAll(() => resetWebPlugins());

/**
 * The repository's own composition installed together, the way doompi sync
 * bundles it. Plugins are independent, so nothing here may depend on order,
 * and nothing may collide: a diagnostic in this set is a bug in one of the
 * packages, not a composition a user chose.
 */
describe('the workspace web plugin composition', () => {
  it('scans every plugin package without a notice and installs them all without a diagnostic', async () => {
    const packages = pluginPackageRoots();
    expect(packages.length).toBeGreaterThan(0);

    const notices: string[] = [];
    const declared = scanWebPlugins(
      hostRoot,
      packages.map((entry) => entry.root),
      (message) => notices.push(message),
    );
    expect(notices).toEqual([]);
    expect(declared).toHaveLength(packages.reduce((sum, entry) => sum + entry.blocks, 0));

    const definitions: WebPluginDefinition[] = [];
    for (const plugin of declared) {
      const entry = path.join(plugin.packageDir, plugin.client.entry);
      const module = (await import(pathToFileURL(entry).href)) as { webPlugin?: WebPluginDefinition };
      expect(module.webPlugin?.id, entry).toBe(plugin.pluginId);
      if (module.webPlugin) definitions.push(module.webPlugin);
    }

    resetWebPlugins();
    installWebPlugins(definitions);
    expect(webPluginDiagnostics()).toEqual([]);
    for (const definition of definitions) {
      for (const slot of definition.slots ?? []) {
        expect(slot.slot.startsWith(`${definition.id}.`), `${definition.id} declares ${slot.slot}`).toBe(true);
      }
    }
  });

  it('keeps the packaged fallback tables equal to what the packages declare', async () => {
    // The packaged bundle carries no plugins, so composition.ts keeps a copy
    // of the axes and minor modes DoomPi ships. This is the only place that
    // copy is checked, so it cannot drift from the packages silently.
    const packages = pluginPackageRoots();
    const declared = scanWebPlugins(
      hostRoot,
      packages.map((entry) => entry.root),
    );
    const definitions: WebPluginDefinition[] = [];
    for (const plugin of declared) {
      const entry = path.join(plugin.packageDir, plugin.client.entry);
      const module = (await import(pathToFileURL(entry).href)) as { webPlugin?: WebPluginDefinition };
      if (module.webPlugin) definitions.push(module.webPlugin);
    }
    resetWebPlugins();
    installWebPlugins(definitions);

    const axis = (source: (typeof PACKAGED_SELECTION_AXES)[number]) => ({
      name: source.name,
      command: source.command,
      statusKey: source.statusKey,
      emptyLabel: source.emptyLabel,
      multi: source.multi === true,
    });
    expect(pluginSelectionAxes().map(axis)).toEqual(PACKAGED_SELECTION_AXES.map(axis));

    const mode = (source: (typeof PACKAGED_MINOR_MODES)[number]) => ({
      name: source.name,
      keys: source.keys,
      statusKey: source.statusKey,
      widgetKey: source.widgetKey,
    });
    expect(pluginMinorModes().map(mode)).toEqual(PACKAGED_MINOR_MODES.map(mode));
  });
});
