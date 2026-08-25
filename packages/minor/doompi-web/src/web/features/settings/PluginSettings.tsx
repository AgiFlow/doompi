import { SectionLabel } from '@agimon-ai/doompi-web-components';
import type { WebPluginDefinition } from '@agimon-ai/doompi-web-contracts';
import { installedWebPlugins, webPluginDiagnostics } from '../../lib/pluginRegistry.ts';

/** What one plugin contributes, as counts: enough to see it landed without opening its code. */
function contributions(plugin: WebPluginDefinition): string[] {
  const parts: string[] = [];
  const count = (label: string, list: readonly unknown[] | undefined): void => {
    if (list !== undefined && list.length > 0) parts.push(`${String(list.length)} ${label}`);
  };
  count('tabs', plugin.tabs);
  count('channels', plugin.channels);
  count('tool renderers', plugin.toolRenderers);
  count('activity groups', plugin.activityGroups);
  count('activity sections', plugin.activitySections);
  count('minor modes', plugin.minorModes);
  count('selection axes', plugin.selectionAxes);
  count('leader bindings', plugin.leaderBindings);
  count('slots', plugin.slots);
  count('fills', plugin.fills);
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
    <div data-testid="settings-plugins" className="flex max-w-[640px] flex-col gap-5">
      <div className="flex flex-col gap-2">
        <SectionLabel>installed</SectionLabel>
        <p className="text-[11px] leading-relaxed text-doom-faint">
          the web plugins compiled into this bundle; doompi sync rebuilds it from the packages installed in the
          composition.
        </p>
        {plugins.length === 0 ? (
          <p data-testid="settings-plugins-empty" className="text-[11px] text-doom-dim">
            no web plugins in this bundle. run doompi sync to bundle the installed packages.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {plugins.map((plugin) => (
              <li
                key={plugin.id}
                data-testid={`settings-plugin-${plugin.id}`}
                className="flex items-baseline gap-3 rounded-md border border-doom-border px-3 py-2"
              >
                <span className="text-[12px] font-bold text-doom-hi">{plugin.id}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-doom-faint">
                  {contributions(plugin).join(' · ') || 'no contributions'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>install diagnostics</SectionLabel>
        <p className="text-[11px] leading-relaxed text-doom-faint">
          plugins are independent, so when two want the same tab, tool, group, or key the install keeps one and records
          the other here rather than failing the page.
        </p>
        {diagnostics.length === 0 ? (
          <p data-testid="settings-plugin-diagnostics-empty" className="text-[11px] text-doom-dim">
            nothing to resolve: no two plugins wanted the same name.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {diagnostics.map((diagnostic, index) => (
              <li
                key={`${diagnostic.pluginId}:${diagnostic.kind}:${String(index)}`}
                data-testid={`settings-plugin-diagnostic-${diagnostic.pluginId}`}
                data-kind={diagnostic.kind}
                className="flex flex-col gap-0.5 rounded-md border border-doom-border px-3 py-2"
              >
                <span className="text-[10px] font-bold text-doom-yellow">
                  {diagnostic.pluginId} · {diagnostic.kind}
                </span>
                <span className="text-[10px] leading-snug text-doom-dim">{diagnostic.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
