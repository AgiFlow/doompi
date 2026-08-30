import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderPlugin, slotPropsFixture, toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { WebPluginDefinition, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import type { ComponentType } from 'react';
import { afterAll, describe, expect, it } from 'vitest';
import { scanWebPlugins } from '../../src/adapters/webPluginScan.ts';
import { PACKAGED_MINOR_MODES, PACKAGED_SELECTION_AXES } from '../../src/web/lib/composition.ts';
import {
  installWebPlugins,
  pluginMinorModes,
  pluginSelectionAxes,
  resetWebPlugins,
  webPluginDiagnostics,
} from '../../src/web/lib/pluginRegistry.ts';
import { HOST_ROOT, pluginPackageRoots } from '../support/pluginRoots.ts';

/**
 * Every workspace plugin's client definition, imported once.
 *
 * Seventeen packages' React trees is real work, and every test below wants the
 * same set, so the import happens once and the tests reinstall from it. This
 * suite shares a process with integration tests that bind sockets, and doing it
 * per test was measurable load for no coverage.
 */
let loaded: Promise<WebPluginDefinition[]> | undefined;

async function loadDefinitions(): Promise<WebPluginDefinition[]> {
  loaded ??= (async () => {
    const declared = scanWebPlugins(
      HOST_ROOT,
      pluginPackageRoots().map((entry) => entry.root),
    );
    const definitions: WebPluginDefinition[] = [];
    for (const plugin of declared) {
      const entry = path.join(plugin.packageDir, plugin.client.entry);
      const module = (await import(pathToFileURL(entry).href)) as { webPlugin?: WebPluginDefinition };
      if (module.webPlugin) definitions.push(module.webPlugin);
    }
    return definitions;
  })();
  return loaded;
}

/** The installed set every rendering test reads. */
async function installed(): Promise<WebPluginDefinition[]> {
  const definitions = await loadDefinitions();
  resetWebPlugins();
  installWebPlugins(definitions);
  return definitions;
}

afterAll(() => resetWebPlugins());

/**
 * The repository's own composition installed together, the way doompi sync
 * bundles it. Plugins are independent, so nothing here may depend on order,
 * and nothing may collide: a diagnostic in this set is a bug in one of the
 * packages, not a composition a user chose.
 */
describe('the workspace web plugin composition', () => {
  it(
    'scans every plugin package without a notice and installs them all without a diagnostic',
    { timeout: 30_000 },
    async () => {
      const packages = pluginPackageRoots();
      expect(packages.length).toBeGreaterThan(0);

      const notices: string[] = [];
      const declared = scanWebPlugins(
        HOST_ROOT,
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
    },
  );

  it('keeps the packaged fallback tables equal to what the packages declare', async () => {
    // The packaged bundle carries no plugins, so composition.ts keeps a copy
    // of the axes and minor modes DoomPi ships. This is the only place that
    // copy is checked, so it cannot drift from the packages silently.
    await installed();

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

  it('installs the Loop activity group and section from the workspace package', async () => {
    const definitions = await installed();
    const loop = definitions.find(({ id }) => id === 'loop');

    expect(loop?.activityGroups).toEqual([
      { name: 'loops', keys: 'l l', statusKey: 'doom-loop-instances', hideWhenEmpty: true, order: 40 },
    ]);
    expect(loop?.activitySections?.map(({ id }) => id)).toEqual(['loops']);
  });

  /**
   * Every component every plugin contributes, mounted once.
   *
   * The host catches whatever a plugin component throws and swaps in a
   * fallback, so a broken one is invisible: the page still renders, just
   * without that panel. Nothing outside the browser suite had ever mounted one
   * of these, and the browser suite does not run on a pull request.
   */
  it('mounts every surface every plugin contributes, for a focused session', async () => {
    const definitions = await installed();
    const { props } = slotPropsFixture({ sessionId: 's1' });
    const failures: string[] = [];

    const mount = (label: string, component: ComponentType<WebPluginSlotProps>): void => {
      const { error } = renderPlugin(component, props);
      if (error) failures.push(`${label}: ${error.message}`);
    };

    for (const definition of definitions) {
      for (const tab of definition.tabs ?? []) mount(`${definition.id} tab ${tab.id}`, tab.panel);
      for (const group of [
        'activitySections',
        'composerActions',
        'overlays',
        'railSections',
        'selectionBarItems',
      ] as const) {
        for (const surface of definition[group] ?? [])
          mount(`${definition.id} ${group} ${surface.id}`, surface.component);
      }
      for (const fill of definition.fills ?? []) {
        if (fill.component) mount(`${definition.id} fill ${fill.slot}/${fill.id}`, fill.component);
      }
    }

    expect(failures).toEqual([]);
  });

  it('mounts every surface with nothing focused', async () => {
    // The host holds sessionId null before the first session is focused and
    // after the last one closes; a component that assumes a session crashes
    // on an empty cockpit, which is the first thing a new user sees.
    const definitions = await installed();
    const { props } = slotPropsFixture({ sessionId: null });
    const failures: string[] = [];

    for (const definition of definitions) {
      for (const tab of definition.tabs ?? []) {
        const { error } = renderPlugin(tab.panel, props);
        if (error) failures.push(`${definition.id} tab ${tab.id}: ${error.message}`);
      }
      for (const surface of definition.activitySections ?? []) {
        const { error } = renderPlugin(surface.component, props);
        if (error) failures.push(`${definition.id} section ${surface.id}: ${error.message}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('mounts every claimed tool renderer before its tool has produced output', async () => {
    const definitions = await installed();
    const failures: string[] = [];

    for (const definition of definitions) {
      for (const renderer of definition.toolRenderers ?? []) {
        for (const toolName of renderer.tools) {
          // result is null until the first output arrives, and a renderer that
          // reads through it fails on the frame that opens its own card.
          const { props } = toolMessagePropsFixture({ toolName, running: true });
          const { error } = renderPlugin(renderer.message, props);
          if (error) failures.push(`${definition.id} tool ${toolName}: ${error.message}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
