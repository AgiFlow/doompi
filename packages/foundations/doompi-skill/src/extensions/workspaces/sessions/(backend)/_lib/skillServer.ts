import { readFile } from 'node:fs/promises';

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
  const { inventory, catalog, groups, mcpGroups, listed } = await discoverServerSkills(agent.context, signal);
  return {
    commands: createSkillCommands(inventory, catalog, groups),
    services: [mountMcpSkills(mcpGroups, signal)],
    resources: [
      // Each skill joins the prompt's one <available_skills> list, gated like the rest.
      ...listed.flatMap((group) =>
        group.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: skill.filePath,
          kind: 'skill' as const,
          ...(group.domain === undefined
            ? {}
            : { when: { domain: group.domain, attribution: { kind: 'domain' as const, mode: group.domain } } }),
          read: () => readFile(skill.filePath, 'utf8'),
        })),
      ),
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
