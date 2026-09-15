import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { serverPromptCommand } from '../../../../controllers/serverPrompts';
import { savedPrompts, readPromptSkill } from '../../../../services/savedPrompts';
export default {
  resources: [
    { name: 'doompi/prompts', kind: 'prompt', read: async () => JSON.stringify(await savedPrompts(), null, 2) },
    { name: 'doompi-use-prompt', kind: 'skill', read: readPromptSkill },
  ],
  commands: [serverPromptCommand],
} satisfies NonNullable<DoomServerPluginDefinition['session']>;
