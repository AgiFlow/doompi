import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { PACKAGE_SOURCE } from '../constants/prompt';
import { api } from '../controllers/promptsApi';
import { serverPromptCommand } from '../controllers/serverPrompts';
import { savedPrompts, readPromptSkill } from '../services/savedPrompts';
export const promptServerFacet = defineServerPlugin({
  name: PACKAGE_SOURCE,
  global: { api: [api] },
  workspace: { api: [api] },
  session: {
    api: [api],
    resources: [
      { name: 'doompi/prompts', kind: 'prompt', read: async () => JSON.stringify(await savedPrompts(), null, 2) },
      { name: 'doompi-use-prompt', kind: 'skill', read: readPromptSkill },
    ],
    commands: [serverPromptCommand],
  },
});
export default promptServerFacet;
