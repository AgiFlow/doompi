import type { DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import {
  type DoomServerSessionPlugin,
  packageResourcePath,
  readPackageResource,
} from '@agimon-ai/doompi-core/serverFacet';

import { mountMcpSkills } from '../../../../../services/mcpSkills';
import { discoverServerSkills } from '../../../../../services/serverInventory';
import { createSkillCommands } from './skillCommands';

export async function createSkillServer(
  agent: DoomHeadlessHostService,
  signal: AbortSignal,
): Promise<DoomServerSessionPlugin> {
  const { inventory, catalog, groups, mcpGroups } = await discoverServerSkills(agent.context, signal);
  return {
    commands: createSkillCommands(inventory, catalog, groups),
    services: [mountMcpSkills(mcpGroups, signal)],
    resources: [
      { name: 'doompi/skills', kind: 'skill', read: () => catalog },
      ...[
        {
          name: 'doompi-author-skill',
          description:
            'Author and distribute DoomPi agent skills. Use when creating a SKILL.md, contributing a runtime skill directory, or publishing activation-gated Help prompts and diagnostic tools.',
        },
        {
          name: 'doompi-use-skill',
          description:
            "Use DoomPi's skill catalog and deferred discovery. Diagnose missing or shadowed skills and invoke the narrowest available guidance.",
        },
      ].map((skill) => ({
        ...skill,
        when: { state: { 'minor-mode': 'help' }, attribution: { kind: 'minor' as const, mode: 'help' } },
        kind: 'skill' as const,
        path: packageResourcePath(import.meta.url, `src/prompts/${skill.name}/SKILL.md`),
        read: () => readPackageResource(import.meta.url, `src/prompts/${skill.name}/SKILL.md`),
      })),
    ],
  };
}
