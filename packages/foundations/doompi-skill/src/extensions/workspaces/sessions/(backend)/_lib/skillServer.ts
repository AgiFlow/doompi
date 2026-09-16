import type { DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { type DoomServerSessionPlugin, readPackageResource } from '@agimon-ai/doompi-core/server-facet';

import { discoverServerSkills } from '../../../../../services/serverInventory';
import { createSkillCommands } from './skillCommands';
export async function createSkillServer(
  agent: DoomHeadlessHostService,
  signal: AbortSignal,
): Promise<DoomServerSessionPlugin> {
  const { inventory, catalog, groups } = await discoverServerSkills(agent.context, signal);
  return {
    commands: createSkillCommands(inventory, catalog, groups),
    resources: [
      { name: 'doompi/skills', kind: 'skill', read: () => catalog },
      ...['doompi-author-skill', 'doompi-use-skill'].map((name) => ({
        name,
        kind: 'skill' as const,
        read: () => readPackageResource(import.meta.url, `src/prompts/${name}/SKILL.md`),
      })),
    ],
  };
}
