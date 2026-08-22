import type { LeaderContribution } from '@agimon-ai/doompi-extension-contracts/leader';

export const SKILLS_COMMAND = 'skills';
export const SKILL_INVOCATION_PREFIX = '/skill:';
export const SKILL_COMMAND_PREFIX = 'skill:';
export const LEADER_SOURCE = '@agimon-ai/doompi-skill';

/**
 * The `SPC e s` binding.
 *
 * The label and order repeat the core extension group exactly; the registry
 * rejects a contribution whose shared prefix disagrees.
 */
export const SKILLS_LEADER_CONTRIBUTION = {
  source: LEADER_SOURCE,
  bindings: [
    {
      id: 'skills.browse',
      path: [
        { key: 'e', label: 'extension', detail: 'tools, skills and config', order: 50 },
        { key: 's', label: 'skills', detail: 'browse catalog' },
      ],
      command: { name: SKILLS_COMMAND },
    },
  ],
} satisfies LeaderContribution;
