import type { WebPluginContributions, WebPluginDefinition } from '@agimon-ai/doompi-core/web';
import { Panel, SectionLabel } from '@agimon-ai/doompi-web-components';

import { installedWebPlugins, webPluginDiagnostics } from '../../lib/pluginRegistry';
import { SettingsSectionHeader } from './SettingsSectionHeader';

/** What one plugin contributes, as counts: enough to see it landed without opening its code. */
function contributions(plugin: WebPluginDefinition): string[] {
  const parts: string[] = [];
  const scopes: readonly WebPluginContributions[] = [
    plugin,
    ...[plugin.global, plugin.workspace, plugin.session].filter(
      (scope): scope is WebPluginContributions => scope !== undefined,
    ),
  ];
  const count = (label: string, select: (scope: WebPluginContributions) => readonly unknown[] | undefined): void => {
    const total = scopes.reduce((sum, scope) => sum + (select(scope)?.length ?? 0), 0);
    if (total > 0) parts.push(`${String(total)} ${label}`);
  };
  count('tabs', (scope) => scope.tabs);
  count('channels', (scope) => scope.channels);
  count('tool renderers', (scope) => scope.toolRenderers);
  count('activity groups', (scope) => scope.activityGroups);
  count('activity sections', (scope) => scope.activitySections);
  count('composer menu items', (scope) => scope.composerMenuItems);
  count('minor modes', (scope) => scope.minorModes);
  count('selection axes', (scope) => scope.selectionAxes);
  count('leader bindings', (scope) => scope.leaderBindings);
  count('slots', (scope) => scope.slots);
  count('fills', (scope) => scope.fills);
  return parts;
}

/**
 * The plugins page: the web plugins this bundle carries and what the install
 * had to resolve between them. Both are read once from the registry, which
 * is complete before the first render; a plugin comes or goes with the next
 * doompi sync, never at runtime.
 */
export function PluginSettings() {
  const plugins = installedWebPlugins();
  const diagnostics = webPluginDiagnostics();
  return (
    <div data-testid="settings-plugins" className="flex flex-col gap-5">
      <SettingsSectionHeader
        title="plugins"
        detail="the web plugins this bundle carries and what their install resolved."
      />
      <div className="flex flex-col gap-2">
        <SectionLabel>installed</SectionLabel>
        <p className="text-sm leading-relaxed text-doom-faint">
          the web plugins compiled into this bundle; doompi sync rebuilds it from the packages installed in the
          composition.
        </p>
        {plugins.length === 0 ? (
          <p data-testid="settings-plugins-empty" className="text-sm text-doom-dim">
            no web plugins in this bundle. run doompi sync to bundle the installed packages.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {plugins.map((plugin) => (
              <Panel
                asChild
                key={plugin.id}
                className="flex flex-col gap-0.5 bg-transparent px-3 py-2 min-[480px]:flex-row min-[480px]:items-baseline min-[480px]:gap-3"
              >
                <li data-testid={`settings-plugin-${plugin.id}`}>
                  <span className="text-sm font-bold text-doom-hi">{plugin.id}</span>
                  {/* Wraps rather than truncates: a clipped "2 lea…" tells the
                      reader less than nothing about what the plugin contributed. */}
                  <span className="min-w-0 w-full text-xs leading-relaxed text-doom-faint min-[480px]:w-auto min-[480px]:flex-1">
                    {contributions(plugin).join(' · ') || 'no contributions'}
                  </span>
                </li>
              </Panel>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>install diagnostics</SectionLabel>
        <p className="text-sm leading-relaxed text-doom-faint">
          plugins are independent, so when two want the same tab, tool, group, or key the install keeps one and records
          the other here rather than failing the page.
        </p>
        {diagnostics.length === 0 ? (
          <p data-testid="settings-plugin-diagnostics-empty" className="text-sm text-doom-dim">
            nothing to resolve: no two plugins wanted the same name.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {diagnostics.map((diagnostic, index) => (
              <Panel
                asChild
                key={`${diagnostic.pluginId}:${diagnostic.kind}:${String(index)}`}
                className="flex flex-col gap-0.5 bg-transparent px-3 py-2"
              >
                <li data-testid={`settings-plugin-diagnostic-${diagnostic.pluginId}`} data-kind={diagnostic.kind}>
                  <span className="text-xs font-bold text-doom-yellow">
                    {diagnostic.pluginId} · {diagnostic.kind}
                  </span>
                  <span className="text-xs leading-snug text-doom-dim">{diagnostic.message}</span>
                </li>
              </Panel>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
