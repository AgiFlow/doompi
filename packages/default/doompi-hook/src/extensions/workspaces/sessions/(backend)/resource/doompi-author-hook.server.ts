import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { readHookResource } from '../../../../../services/hookResource';
export default defineRoutedContribution(
  { name: 'doompi-author-hook', kind: 'skill' as const, read: readHookResource },
  {},
);
