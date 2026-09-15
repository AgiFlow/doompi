import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
export function extensionLayers(config: MajorModesConfig, names: readonly string[]): string[] {
  return names.filter((name) => {
    const layer = config.layers[name];
    return Boolean(layer && ((layer.extensions?.length ?? 0) > 0 || (layer.packages?.length ?? 0) > 0));
  });
}

export function needsRelaunch(config: MajorModesConfig, before: readonly string[], after: readonly string[]): boolean {
  const previous = extensionLayers(config, before);
  const candidate = extensionLayers(config, after);
  return previous.length !== candidate.length || previous.some((name, index) => name !== candidate[index]);
}
