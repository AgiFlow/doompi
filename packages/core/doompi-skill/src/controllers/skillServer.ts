import type { DoomHeadlessHostService } from '@agimon-ai/doompi-extension-contracts/headless';
import type { DoomServerSessionPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { discoverServerSkills } from '../services/serverInventory';
import { readPackageResource } from '../services/packageResources';
import { createSkillCommands } from './skillCommands';
export async function createSkillServer(
  agent: DoomHeadlessHostService,
  signal: AbortSignal,
): Promise<DoomServerSessionPlugin> {
  const { inventory, catalog } = await discoverServerSkills(agent.context, signal);
  return {
    commands: createSkillCommands(inventory, catalog),
    resources: [
      { name: 'doompi/skills', kind: 'skill', read: () => catalog },
      ...['doompi-author-skill', 'doompi-use-skill'].map((name) => ({
        name,
        kind: 'skill' as const,
        read: () => readPackageResource(`src/prompts/${name}/SKILL.md`),
      })),
    ],
  };
}
