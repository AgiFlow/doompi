import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { HOOK_HELP_SKILL, PACKAGE_SOURCE } from '../../../../../constants/hook';
export default defineRoutedContribution(
  { source: PACKAGE_SOURCE, moduleUrl: import.meta.url, skills: [HOOK_HELP_SKILL] },
  {},
);
