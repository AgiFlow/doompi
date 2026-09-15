import { defineResource } from '@agimon-ai/doompi-core/extension-file';

import { LEADER_SOURCE } from '../../../../../types/skills';
export default defineResource({
  source: LEADER_SOURCE,
  moduleUrl: import.meta.url,
  skills: [
    {
      name: 'doompi-author-skill',
      description:
        'Author and distribute DoomPi agent skills. Use when creating a SKILL.md, adding supporting references or scripts, contributing a runtime skill directory through Cordis, or publishing activation-gated Help prompts from a DoomPi package.',
    },
    {
      name: 'doompi-use-skill',
      description:
        "Use DoomPi's skill catalog and deferred discovery. Use when browsing available skills, invoking /skill:name, understanding Help and extension-owned skill groups, or diagnosing why a skill is absent or shadowed.",
    },
  ],
});
