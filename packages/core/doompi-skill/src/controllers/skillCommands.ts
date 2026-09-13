import type { DoomHeadlessCommand } from '@agimon-ai/doompi-core/headless';

import { expandDeferredSkillCommand, type DeferredSkillSnapshot } from '../services/deferredSkills';
import { SKILLS_COMMAND } from '../types/skills';
export function createSkillCommands(inventory: DeferredSkillSnapshot, catalog: string): readonly DoomHeadlessCommand[] {
  return [
    {
      name: SKILLS_COMMAND,
      description: 'List discovered skills or invoke one by name.',
      async execute(args, execution) {
        const requested = args.trim();
        if (requested) {
          await execution.session.prompt(expandDeferredSkillCommand(`/skill:${requested}`, inventory.skills));
          return;
        }
        await execution.client.notify({
          title: 'DoomPi skills',
          body: catalog,
          level: 'info',
        });
      },
    },
    ...inventory.skills.map((skill): DoomHeadlessCommand => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      execute: async (args, execution) => {
        const text = `/skill:${skill.name}${args ? ` ${args}` : ''}`;
        const expanded = expandDeferredSkillCommand(text, inventory.skills);
        if (expanded === text) throw new Error(`Skill '${skill.name}' is no longer readable.`);
        await execution.session.prompt(expanded);
      },
    })),
  ];
}
