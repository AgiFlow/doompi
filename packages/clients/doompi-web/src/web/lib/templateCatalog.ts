import {
  parseWebTemplate,
  type WebPluginDefinition,
  type WebPluginScope,
  type WebTemplateContribution,
} from '@agimon-ai/doompi-core/web';
import { webPlugin as advancedWebPlugin } from '@agimon-ai/doompi-template-advanced/webClient';

import { pluginsAtScope } from './pluginScopes';
export interface InstalledWebTemplate extends WebTemplateContribution {
  pluginId: string;
}

export interface WebTemplateDiagnostic {
  kind: 'invalid-template' | 'duplicate-template';
  pluginId: string;
  message: string;
}

export interface WebTemplateCatalog {
  templates: InstalledWebTemplate[];
  diagnostics: WebTemplateDiagnostic[];
}

/** Read scoped plugin templates, then provide Advanced when no composition owns it. */
export function collectWebTemplates(
  plugins: readonly WebPluginDefinition[],
  scope?: WebPluginScope,
): WebTemplateCatalog {
  const templates = new Map<string, InstalledWebTemplate>();
  const diagnostics: WebTemplateDiagnostic[] = [];
  const collect = (plugin: WebPluginDefinition): void => {
    let entries: unknown;
    try {
      entries = plugin.templates;
    } catch {
      diagnostics.push({
        kind: 'invalid-template',
        pluginId: plugin.id,
        message: `Template metadata from '${plugin.id}' could not be read.`,
      });
      return;
    }
    if (entries === undefined) return;
    if (!Array.isArray(entries)) {
      diagnostics.push({
        kind: 'invalid-template',
        pluginId: plugin.id,
        message: `Plugin '${plugin.id}' must declare templates as an array.`,
      });
      return;
    }
    for (const entry of entries) {
      let template: WebTemplateContribution | undefined;
      try {
        template = parseWebTemplate(entry);
      } catch {
        template = undefined;
      }
      if (template === undefined) {
        diagnostics.push({
          kind: 'invalid-template',
          pluginId: plugin.id,
          message: `Plugin '${plugin.id}' declares an invalid template or an unsupported template contract.`,
        });
        continue;
      }
      const owner = templates.get(template.id);
      if (owner !== undefined) {
        diagnostics.push({
          kind: 'duplicate-template',
          pluginId: plugin.id,
          message: `Template '${template.id}' is already provided by '${owner.pluginId}'; keeping the first.`,
        });
        continue;
      }
      templates.set(template.id, { ...template, pluginId: plugin.id });
    }
  };

  for (const plugin of plugins) collect(plugin);
  if (scope !== undefined && !templates.has('doompi-template-advanced'))
    for (const plugin of pluginsAtScope([advancedWebPlugin], scope)) collect(plugin);
  return { templates: [...templates.values()], diagnostics };
}

/** A missing default stays in config, since another workspace may still provide it. */
export function resolveWebTemplate(
  templates: readonly InstalledWebTemplate[],
  configured: string | undefined,
  failed: readonly string[] = [],
): { template: InstalledWebTemplate | undefined; warning: string | undefined } {
  const available = templates.filter((template) => !failed.includes(template.id));
  const preferred = available.find((template) => template.id === configured);
  const template =
    preferred ??
    available.find((candidate) => candidate.id === 'doompi-template-advanced') ??
    [...available].sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!template)
    return {
      template: undefined,
      warning: 'No compatible web template is available. Add a template package to modes.yaml and run doompi sync.',
    };
  if (configured && !preferred)
    return { template, warning: `Configured template '${configured}' is unavailable; showing '${template.label}'.` };
  if (failed.length > 0)
    return { template, warning: 'A template could not render. A different available template is being shown.' };
  return { template, warning: undefined };
}
