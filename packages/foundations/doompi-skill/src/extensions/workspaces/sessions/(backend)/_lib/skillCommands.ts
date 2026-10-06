import type { DoomHeadlessCommand, DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { Skill } from '@earendil-works/pi-coding-agent';

import { expandDeferredSkillCommand, type DeferredSkillSnapshot } from '../../../../../services/deferredSkills';
import type { ServerSkillGroup } from '../../../../../services/serverInventory';
import { SKILL_COMMAND_PREFIX, SKILL_INVOCATION_PREFIX, SKILLS_COMMAND } from '../../../../../types/skills';

/**
 * Admits the expanded skill without awaiting its turn.
 *
 * A command's `execute` is the prompt's admission acknowledgement: the web
 * composer keeps the draft until it returns. `session.prompt` awaits the whole
 * turn, so the `/skill:` draft stayed in the composer until the agent finished.
 */
async function admitSkill(execution: DoomHeadlessExecutionContext, text: string): Promise<void> {
  if (!execution.session.admitPrompt) throw new Error('The session cannot admit a skill prompt.');
  await execution.session.admitPrompt(text, 'prompt', 'operator');
}
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
      await admitSkill(execution, expanded);
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
          await admitSkill(
            execution,
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
