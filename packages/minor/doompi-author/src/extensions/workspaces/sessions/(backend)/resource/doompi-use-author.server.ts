import { defineResource } from '@agimon-ai/doompi-core/extension-file';

import { readAuthorPrompt } from '../../../../../services/authorPrompt';

export default defineResource({
  when: { state: { 'minor-mode': 'author' }, attribution: { kind: 'minor' as const, mode: 'author' } },
  name: 'doompi-use-author',
  kind: 'skill' as const,
  read: () => readAuthorPrompt(),
});
