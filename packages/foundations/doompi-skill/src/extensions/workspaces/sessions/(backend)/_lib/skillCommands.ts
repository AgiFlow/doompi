import type { DoomHeadlessCommand } from '@agimon-ai/doompi-core/headless';
import type { Skill } from '@earendil-works/pi-coding-agent';

import { expandDeferredSkillCommand, type DeferredSkillSnapshot } from '../../../../../services/deferredSkills';
import type { ServerSkillGroup } from '../../../../../services/serverInventory';
import { SKILL_COMMAND_PREFIX, SKILL_INVOCATION_PREFIX, SKILLS_COMMAND } from '../../../../../types/skills';

/**
 * One command per skill, gated by whatever activates that skill.
 *
 * Expansion always reads the full inventory, not the group: a command is only
 * dispatchable while its condition holds, so by the time one runs its skill is
 * active, and looking it up in the union keeps one lookup table instead of one
 * per domain.
 */
function skillCommand(skill: Skill, domain: string | undefined, inventory: DeferredSkillSnapshot): DoomHeadlessCommand {
  return {
    ...(domain === undefined ? {} : { when: { domain } }),
    name: `${SKILL_COMMAND_PREFIX}${skill.name}`,
    description: skill.description,
    execute: async (args, execution) => {
      const text = `${SKILL_INVOCATION_PREFIX}${skill.name}${args ? ` ${args}` : ''}`;
      const expanded = expandDeferredSkillCommand(text, inventory.skills);
      if (expanded === text) throw new Error(`Skill '${skill.name}' is no longer readable.`);
      await execution.session.prompt(expanded);
    },
  };
}

export function createSkillCommands(
  inventory: DeferredSkillSnapshot,
  catalog: string,
  groups: readonly ServerSkillGroup[],
): readonly DoomHeadlessCommand[] {
  return [
    {
      name: SKILLS_COMMAND,
      description: 'List discovered skills or invoke one by name.',
      async execute(args, execution) {
        const requested = args.trim();
        if (requested) {
          await execution.session.prompt(
            expandDeferredSkillCommand(`${SKILL_INVOCATION_PREFIX}${requested}`, inventory.skills),
          );
          return;
        }
        await execution.client.notify({
          title: 'DoomPi skills',
          body: catalog,
          level: 'info',
        });
      },
    },
    ...groups.flatMap((group) => group.skills.map((skill) => skillCommand(skill, group.domain, inventory))),
  ];
}
