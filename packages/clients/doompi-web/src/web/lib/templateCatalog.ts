import { parseWebTemplate, type WebPluginDefinition, type WebTemplateContribution } from '@agimon-ai/doompi-core/web';

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

/** Read the existing, scoped plugin set. No second loader or mutable registry is needed. */
export function collectWebTemplates(plugins: readonly WebPluginDefinition[]): WebTemplateCatalog {
  const templates = new Map<string, InstalledWebTemplate>();
  const diagnostics: WebTemplateDiagnostic[] = [];
  for (const plugin of plugins) {
    let entries: unknown;
    try {
      entries = plugin.templates;
    } catch {
      diagnostics.push({
        kind: 'invalid-template',
        pluginId: plugin.id,
        message: `Template metadata from '${plugin.id}' could not be read.`,
      });
      continue;
    }
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      diagnostics.push({
        kind: 'invalid-template',
        pluginId: plugin.id,
        message: `Plugin '${plugin.id}' must declare templates as an array.`,
      });
      continue;
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
  }
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
