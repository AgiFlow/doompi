import { defineResource } from '@agimon-ai/doompi-core/extension-file';

import { savedPrompts } from '../../../../../services/savedPrompts';
export default defineResource({
  name: 'doompi/prompts',
  kind: 'prompt' as const,
  read: async () => JSON.stringify(await savedPrompts(), null, 2),
});
