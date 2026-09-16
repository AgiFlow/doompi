import type { PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

export function workflowSkillsResource(
  resources: PiPluginContributions['resources'],
  moduleUrl: string,
): NonNullable<PiPluginContributions['resources']>[number] | undefined {
  const resource = resources?.[0];
  return resource ? { ...resource, moduleUrl } : undefined;
}
