import type { WebPluginDefinition, WebPluginScope } from '@agimon-ai/doompi-core/web';

/** Select one declared mount from a verified composition. */
export function pluginsAtScope(plugins: readonly WebPluginDefinition[], scope: WebPluginScope): WebPluginDefinition[] {
  return plugins.flatMap((plugin) => {
    const contribution = plugin[scope];
    return contribution === undefined ? [] : [{ id: plugin.id, ...contribution }];
  });
}

function contributionKey(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if ('id' in value && typeof value.id === 'string') return value.id;
  if ('name' in value && typeof value.name === 'string') return value.name;
  if ('frameType' in value && typeof value.frameType === 'string') return value.frameType;
  if ('slot' in value && typeof value.slot === 'string') return value.slot;
  if ('tools' in value && Array.isArray(value.tools) && value.tools.length) return value.tools.join('\0');
  return undefined;
}

/** Child contributions replace equal keys while retaining unrelated parent contributions. */
export function mergeScopedPlugins(...levels: readonly (readonly WebPluginDefinition[])[]): WebPluginDefinition[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const plugins of levels)
    for (const plugin of plugins) {
      const result = merged.get(plugin.id) ?? { id: plugin.id };
      for (const [field, value] of Object.entries(plugin)) {
        if (field === 'start') continue;
        if (Array.isArray(value)) {
          const previous = result[field];
          const values: unknown[] = Array.isArray(previous) ? [...previous] : [];
          for (const item of value) {
            const key = contributionKey(item);
            const index = key === undefined ? -1 : values.findIndex((candidate) => contributionKey(candidate) === key);
            if (index === -1) values.push(item);
            else values[index] = item;
          }
          result[field] = values;
        } else result[field] = value;
      }
      merged.set(plugin.id, result);
    }
  return [...merged.values()] as unknown as WebPluginDefinition[];
}
